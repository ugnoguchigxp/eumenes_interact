import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMON_ACTIONS } from "../../../src/contracts/operation.ts";
import type { AdapterCommand } from "../../../src/contracts/operation.ts";
import {
	EXTRACT_SCRIPT,
	INSPECT_FOCUSED_SCRIPT,
} from "../../../src/adapters/agent-browser/adapter.ts";
import { locateScript } from "../../../src/adapters/agent-browser/locate.ts";
import {
	INSPECT_LOCATOR_FUNCTION,
	INSPECT_TARGET_FUNCTION,
} from "../../../src/adapters/mcp/inspect.ts";
import { createAgentBrowserAdapter } from "../../../src/adapters/agent-browser/adapter.ts";
import {
	ALLOWED_AGENT_BROWSER_TOOLS,
	isAllowedTool,
} from "../../../src/adapters/agent-browser/tools.ts";
import { McpTransportError } from "../../../src/adapters/mcp/session.ts";
import {
	EXTRACT_HARD_MAX_CHARS,
	EXTRACT_TARGET_FUNCTION,
} from "../../../src/adapters/mcp/extract.ts";
import {
	CORE_TABS,
	cleanup,
	failure,
	defaultTool,
	FakeSession,
	hang,
	NEVER,
	opened,
	setup,
	type ToolHandler,
	text,
	TREE,
} from "./fakes.ts";

afterEach(cleanup);

/** What a click, key or submit does before its url is read. */
const SETTLE = [
	"agent_browser_wait_for_load",
	{ state: "domcontentloaded", waitTimeoutMs: 5000 },
];

const CLICK: AdapterCommand = {
	action: "page.click",
	targetRef: "e4",
	element: "open",
};

test("open starts the host's executable, owns the session and config, and launches no browser", async () => {
	const { adapter, fake, launches, workDir } = setup({
		env: { HOST_VAR: "x", AGENT_BROWSER_ARGS: "--no-sandbox" },
	});
	await adapter.open(NEVER);
	expect(adapter.state()).toBe("open");
	const launch = launches[0];
	expect(launch?.command).toBe("/fake/node");
	expect(launch?.args).toEqual([
		"/fake/agent-browser.js",
		"mcp",
		"--tools",
		"core,tabs",
	]);
	expect(launch?.cwd).toBe(join(workDir, "agent-browser"));
	const env = launch?.env ?? {};
	expect(Object.keys(env).sort()).toEqual(
		[
			"AGENT_BROWSER_ARGS",
			"AGENT_BROWSER_CONFIG",
			"AGENT_BROWSER_SESSION",
			"HOME",
			"HOST_VAR",
			"PATH",
		].sort(),
	);
	expect(env.AGENT_BROWSER_SESSION).toMatch(/^ei-[0-9a-f]{16}$/);
	expect(env.AGENT_BROWSER_ARGS).toBe("--no-sandbox\n--mute-audio");
	// An empty config of the adapter's own replaces the user and project configs.
	expect(env.AGENT_BROWSER_CONFIG).toBe(
		join(workDir, "agent-browser.config.json"),
	);
	expect(readFileSync(env.AGENT_BROWSER_CONFIG ?? "", "utf8")).toBe("{}");
	// The tool list was read (two pages) and nothing else was sent: no browser yet.
	expect(fake.requests.map((r) => r.method)).toEqual([
		"initialize",
		"tools/list",
		"tools/list",
	]);
	expect(fake.notified).toEqual(["notifications/initialized"]);
	expect(adapter.toolInfo()).toEqual({
		name: "agent-browser",
		version: "0.39.4",
	});
});

test("every adapter gets its own session, so sessions never share a browser", async () => {
	const a = await opened();
	const b = await opened();
	expect(a.launches[0]?.env.AGENT_BROWSER_SESSION).not.toBe(
		b.launches[0]?.env.AGENT_BROWSER_SESSION,
	);
	const noVersion = setup();
	noVersion.fake.initializeResult = {};
	expect(noVersion.adapter.toolInfo().version).toBeNull();
});

test("a server without open or snapshot is refused and stopped", async () => {
	const ctx = setup({ tools: ["agent_browser_click"] });
	await expect(ctx.adapter.open(NEVER)).rejects.toMatchObject({
		code: "mcp_unavailable",
		dispatched: false,
	});
	expect(ctx.adapter.state()).toBe("closed");
	expect(ctx.fake.closeCount).toBe(1);
});

test("a launch that would attach, reuse a profile or pick the session is refused before anything starts", async () => {
	const cases: Parameters<typeof setup>[0][] = [
		{ args: ["a.js", "mcp", "--cdp", "9222"] },
		{ args: ["a.js", "mcp", "--cdp=9222"] },
		{ args: ["a.js", "mcp", "--auto-connect"] },
		{ args: ["a.js", "mcp", "--profile", "Default"] },
		{ args: ["a.js", "mcp", "-p", "browserbase"] },
		{ args: ["a.js", "mcp", "--session", "shared"] },
		{ args: ["a.js", "mcp", "--config", "/home/me/ab.json"] },
		{ args: ["a.js", "mcp", "--args", "--user-data-dir=/home/me/profile"] },
		{ env: { AGENT_BROWSER_PROFILE: "/home/me/profile" } },
		{ env: { AGENT_BROWSER_SESSION: "shared" } },
		{ env: { AGENT_BROWSER_CDP: "9222" } },
		{ env: { AGENT_BROWSER_ARGS: "--remote-debugging-port=9222" } },
	];
	for (const over of cases) {
		const ctx = setup(over);
		await expect(ctx.adapter.open(NEVER)).rejects.toMatchObject({
			code: "launch_not_isolated",
			dispatched: false,
		});
		expect(ctx.launches).toHaveLength(0);
		expect(ctx.adapter.state()).toBe("closed");
	}
});

test("open failures stop the child; abort and early abort never leave one", async () => {
	const aborting = setup();
	const original = aborting.fake.request.bind(aborting.fake);
	// The tool list never arrives; like the real session, the request ends on abort.
	aborting.fake.request = (method, params, options) =>
		method === "tools/list"
			? new Promise((_, reject) =>
					options.signal?.addEventListener("abort", () =>
						reject(new McpTransportError("aborted", true)),
					),
				)
			: original(method, params, options);
	const controller = new AbortController();
	const pending = aborting.adapter.open(controller.signal);
	await Bun.sleep(20);
	expect(aborting.adapter.state()).toBe("opening");
	controller.abort();
	await expect(pending).rejects.toMatchObject({ code: "aborted" });
	expect(aborting.adapter.state()).toBe("closed");
	expect(aborting.fake.closeCount).toBe(1);

	const early = setup();
	const done = new AbortController();
	done.abort();
	await expect(early.adapter.open(done.signal)).rejects.toMatchObject({
		code: "aborted",
	});
	expect(early.launches).toHaveLength(0);
});

test("a close during open stops the child or prevents it from starting", async () => {
	const early = setup();
	const pending = early.adapter.open(NEVER);
	const closing = early.adapter.close();
	await expect(pending).rejects.toMatchObject({ code: "closed" });
	await closing;
	expect(early.launches).toHaveLength(0);
	expect(early.adapter.state()).toBe("closed");
});

test("the catalog follows the tools the server offers", async () => {
	const { adapter } = await opened();
	const byAction = Object.fromEntries(
		adapter.catalog().map((e) => [e.action, e]),
	);
	expect(adapter.catalog().map((e) => e.action)).toEqual([...COMMON_ACTIONS]);
	expect(
		adapter
			.catalog()
			.filter((e) => !e.supported)
			.map((e) => e.action),
	).toEqual(["page.hover", "page.capture"]);
	for (const action of [
		"page.scroll",
		"page.extract",
		"page.fill",
		"page.wait",
	])
		expect(byAction[action]?.supported).toBe(true);
	expect(byAction["page.click"]?.needsTargetRef).toBe(true);
	expect(byAction["page.press"]?.needsTargetRef).toBe(false);
	expect(adapter.catalog().every((e) => e.platform === "agent-browser")).toBe(
		true,
	);
	expect(adapter.catalog().some((e) => e.physicalInput)).toBe(false);
	const slim = await opened({
		tools: CORE_TABS.filter(
			(n) => n !== "agent_browser_scroll" && n !== "agent_browser_eval",
		),
	});
	const entries = Object.fromEntries(
		slim.adapter.catalog().map((e) => [e.action, e]),
	);
	expect(entries["page.scroll"]?.supported).toBe(false);
	expect(entries["page.extract"]?.supported).toBe(false);
	expect(entries["page.click"]?.supported).toBe(true);
});

test("the first call launches the browser with headed and webmcp off in a blank open of its own; navigations follow", async () => {
	const ctx = await opened({ headless: true });
	await ctx.adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	await ctx.adapter.dispatch(
		{ action: "browser.navigate", url: "https://b.test/" },
		NEVER,
	);
	const opens = ctx.fake.calls().filter((c) => c.name === "agent_browser_open");
	// The browser is launched by a blank open of its own; the navigations follow as on a running browser.
	expect(opens.map((c) => c.arguments)).toEqual([
		{ headed: false, webmcp: false },
		{ url: "https://a.test/", timeoutMs: 45_000 },
		{ url: "https://b.test/", timeoutMs: 45_000 },
	]);
	const headed = await opened({ headless: false });
	await headed.adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	expect(headed.fake.calls()[0]?.arguments).toMatchObject({ headed: true });
});

test("any other first call launches a blank page first", async () => {
	const { adapter, fake } = await opened();
	await adapter.observe(NEVER);
	expect(fake.calls().map((c) => [c.name, c.arguments])).toEqual([
		["agent_browser_open", { headed: false, webmcp: false }],
		["agent_browser_snapshot", { includeUrls: true }],
		["agent_browser_get_url", {}],
		["agent_browser_get_title", {}],
	]);
});

test("observe returns the platform's body untouched with the page, and reports what is missing", async () => {
	const { adapter, fake } = await opened({
		snapshot: { includeUrls: false, interactive: true, compact: true },
	});
	const body = ['- text: "### Page"', "```", TREE].join("\n");
	fake.onTool = (name) =>
		name === "agent_browser_snapshot"
			? text(body)
			: name === "agent_browser_get_url"
				? text("https://a.test/")
				: name === "agent_browser_get_title"
					? text(JSON.stringify("A title"))
					: text("ok");
	expect(await adapter.observe(NEVER)).toEqual({
		body,
		url: "https://a.test/",
		title: "A title",
		truncated: false,
		missing: [],
	});
	expect(
		fake.calls().find((c) => c.name === "agent_browser_snapshot")?.arguments,
	).toEqual({
		includeUrls: false,
		interactive: true,
		compact: true,
	});
	// A url or title the server does not give in a readable form is missing, never guessed.
	fake.onTool = (name) =>
		name === "agent_browser_snapshot" ? text(TREE) : failure("boom");
	expect(await adapter.observe(NEVER)).toEqual({
		body: TREE,
		truncated: false,
		missing: ["url", "title"],
	});
	fake.onTool = (name) =>
		name === "agent_browser_snapshot"
			? { content: [], isError: false }
			: text("ok");
	await expect(adapter.observe(NEVER)).rejects.toMatchObject({
		code: "mcp_response_unrecognized",
		dispatched: false,
	});
	fake.onTool = () => failure("Stale something");
	await expect(adapter.observe(NEVER)).rejects.toMatchObject({
		dispatched: false,
	});
});

test("commands map to the tools, refs become @refs, and the page is reported", async () => {
	const { adapter, fake } = await opened();
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	const before = fake.calls().length;
	const commands: AdapterCommand[] = [
		{ action: "browser.back" },
		CLICK,
		{
			action: "page.fill",
			targetRef: "f1e5",
			element: "q",
			text: "abc",
			submit: false,
		},
		{
			action: "page.fill",
			targetRef: "e5",
			element: "q",
			text: "abc",
			submit: true,
		},
		{ action: "page.select", targetRef: "e6", element: "size", values: ["L"] },
		{ action: "page.press", key: "Enter" },
		{ action: "page.wait", text: "Done", seconds: 1.5 },
		{ action: "page.wait", seconds: 0 },
		{ action: "page.scroll", direction: "down" },
		{ action: "page.scroll", direction: "up", targetRef: "e9" },
	];
	for (const command of commands)
		expect(await adapter.dispatch(command, NEVER)).toEqual({
			status: "confirmed",
			retryable: false,
			url: "https://a.test/",
			title: "A",
		});
	const sent = fake
		.calls()
		.slice(before)
		.filter((c) => !c.name.startsWith("agent_browser_get_"))
		.map((c) => [c.name, c.arguments]);
	expect(sent).toEqual([
		["agent_browser_back", {}],
		["agent_browser_click", { selector: "@e4" }],
		SETTLE,
		["agent_browser_fill", { selector: "@f1e5", text: "abc" }],
		["agent_browser_fill", { selector: "@e5", text: "abc" }],
		["agent_browser_press", { key: "Enter" }],
		SETTLE,
		["agent_browser_select", { selector: "@e6", values: ["L"] }],
		["agent_browser_press", { key: "Enter" }],
		SETTLE,
		["agent_browser_wait_ms", { ms: 1500 }],
		["agent_browser_wait_for_text", { text: "Done" }],
		["agent_browser_wait_ms", { ms: 1 }],
		["agent_browser_scroll", { direction: "down" }],
		["agent_browser_scroll", { direction: "up", selector: "@e9" }],
	]);
});

test("hover, capture, textGone and sideways scroll are unsupported: nothing is sent and nothing stands in", async () => {
	const { adapter, fake } = await opened();
	const before = fake.calls().length;
	for (const command of [
		{ action: "page.hover", targetRef: "e1", element: "x" },
		{ action: "page.capture" },
		{ action: "page.wait", textGone: "Loading" },
		{ action: "page.scroll", direction: "left" },
		{ action: "bogus" },
	] as unknown as AdapterCommand[])
		expect(await adapter.dispatch(command, NEVER)).toEqual({
			status: "not_dispatched",
			code: "unsupported",
			retryable: false,
		});
	expect(fake.calls().length).toBe(before);
	// A tool the server does not offer makes the action unsupported too.
	const slim = await opened({
		tools: CORE_TABS.filter((n) => n !== "agent_browser_select"),
	});
	expect(
		await slim.adapter.dispatch(
			{ action: "page.select", targetRef: "e1", element: "x", values: ["a"] },
			NEVER,
		),
	).toMatchObject({ status: "not_dispatched", code: "unsupported" });
});

test("arguments that are not valid are refused before anything is sent", async () => {
	const { adapter, fake } = await opened();
	const before = fake.calls().length;
	const refused = async (command: AdapterCommand) =>
		(await adapter.dispatch(command, NEVER)).code;
	for (const targetRef of ["body > a", "@e4", "text=Delete", "e4; x", "", "E4"])
		expect(await refused({ ...CLICK, targetRef })).toBe("invalid_ref");
	for (const url of ["javascript:alert(1)", "file:///etc/passwd", "nope"])
		expect(await refused({ action: "browser.navigate", url })).toBe(
			"invalid_url",
		);
	expect(await refused({ action: "page.wait" })).toBe("invalid_wait");
	expect(await refused({ action: "page.wait", seconds: -1 })).toBe(
		"invalid_wait",
	);
	expect(fake.calls().length).toBe(before);
});

test("errors documented as happening before the action are failed; anything else may have acted", async () => {
	const { adapter, fake } = await opened();
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	const run = async (message: string, command: AdapterCommand = CLICK) => {
		fake.onTool = (name) =>
			name.startsWith("agent_browser_get_") ? text("x") : failure(message);
		return adapter.dispatch(command, NEVER);
	};
	const failed = (code: string, retryable = false) => ({
		status: "failed" as const,
		code,
		retryable,
	});
	expect(
		await run(
			'Stale ref for role=button name="Go" cannot be recovered: several elements now match. Run snapshot again and use a fresh ref.',
		),
	).toEqual(failed("stale_ref"));
	expect(await run("Element not found: @e4")).toEqual(failed("stale_ref"));
	expect(await run("Error: Ref not found")).toEqual(failed("stale_ref"));
	expect(
		await run(
			"Element '@e4' is covered by <div#consent-banner> at its click point, so the input would land on that element instead.",
		),
	).toEqual(failed("target_covered"));
	expect(
		await run("Element '@e4' is hidden, so the click would not reach it"),
	).toEqual(failed("target_not_actionable"));
	expect(
		await run(
			"Element '@e4' is outside the viewport, so the click would not reach it",
		),
	).toEqual(failed("target_not_actionable"));
	expect(
		await run(
			JSON.stringify({
				success: false,
				error: "Element '@e4' is disabled, so the click would not reach it",
			}),
		),
	).toEqual(failed("target_not_actionable"));
	expect(await run("Unknown argument(s) for agent_browser_click: foo")).toEqual(
		failed("invalid_params"),
	);
	expect(
		await run(
			"Tool agent_browser_click is not enabled by the active MCP tools profile(s)",
		),
	).toEqual(failed("tool_not_enabled"));
	expect(
		await run("net::ERR_NAME_NOT_RESOLVED at https://x.test/", {
			action: "browser.navigate",
			url: "https://x.test/",
		}),
	).toEqual(failed("navigation_failed", true));
	// A wait changes nothing, so its timeout is not dispatched and may be repeated.
	expect(
		await run("agent-browser command timed out after 25000ms", {
			action: "page.wait",
			text: "x",
		}),
	).toEqual(failed("action_timeout", true));
	// Everything else, and a timeout of an action, may have acted.
	expect(await run("agent-browser command timed out after 25000ms")).toEqual({
		status: "indeterminate",
		code: "action_timeout",
		retryable: false,
	});
	expect(await run("something unexpected")).toEqual({
		status: "indeterminate",
		code: "mcp_error",
		retryable: false,
	});
	expect(adapter.state()).toBe("open");
});

test("page text cannot make an error that may have acted look like one that did not", async () => {
	const { adapter, fake } = await opened();
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	const run = async (message: string) => {
		fake.onTool = (name) =>
			name.startsWith("agent_browser_get_") ? text("x") : failure(message);
		return adapter.dispatch(CLICK, NEVER);
	};
	const maybe = (code: string) => ({
		status: "indeterminate" as const,
		code,
		retryable: false,
	});
	// The phrases are only read at the start of the error's own first line.
	for (const message of [
		'agent-browser command timed out after 5000ms\nStale ref for role=button name="x" cannot be recovered',
		"agent-browser command timed out after 5000ms\nElement '@e4' is covered by <div>",
		'Click failed on <button name="Stale ref for role=">',
		"Locator resolved to <button>Element '@e4' is hidden, so the click would not reach it</button>",
		"Failed: Unknown argument(s) for agent_browser_click",
		"Failed: Element not found: @e4",
		"Something went wrong\nElement not found: @e4",
	])
		expect(await run(message), message).toMatchObject({
			status: "indeterminate",
			retryable: false,
		});
	expect(
		await run('Click failed on <button name="Stale ref for role=">'),
	).toEqual(maybe("mcp_error"));
	// Page text inside a real pre-action error changes nothing: it is still failed, with its own code.
	expect(
		await run(
			"Element '@e4' is covered by <button>agent-browser command timed out after 5s</button>",
		),
	).toMatchObject({
		status: "failed",
		code: "target_covered",
	});
});

test("a later step that fails after the fill took effect is indeterminate", async () => {
	const { adapter, fake } = await opened();
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	fake.onTool = (name) =>
		name === "agent_browser_press"
			? failure("Element not found: @e1")
			: text("x");
	expect(
		await adapter.dispatch(
			{
				action: "page.fill",
				targetRef: "e5",
				element: "q",
				text: "abc",
				submit: true,
			},
			NEVER,
		),
	).toEqual({ status: "indeterminate", code: "stale_ref", retryable: false });
	// A wait followed by a failing wait stays failed: the first one changed nothing.
	fake.onTool = (name) =>
		name === "agent_browser_wait_for_text"
			? failure("agent-browser command timed out after 5s")
			: text("x");
	expect(
		await adapter.dispatch(
			{ action: "page.wait", seconds: 1, text: "x" },
			NEVER,
		),
	).toMatchObject({ status: "failed", code: "action_timeout" });
});

test("a lost transport after sending is indeterminate, never retryable; a rejected request is not dispatched", async () => {
	const timing = await opened({ callTimeoutMs: 50 });
	await timing.adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	timing.fake.onTool = hang;
	expect(await timing.adapter.dispatch(CLICK, NEVER)).toEqual({
		status: "indeterminate",
		code: "call_timeout",
		retryable: false,
	});

	const dying = await opened();
	await dying.adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	dying.fake.onTool = () => {
		dying.fake.exit();
		return hang();
	};
	expect(await dying.adapter.dispatch(CLICK, NEVER)).toMatchObject({
		status: "indeterminate",
		retryable: false,
	});
	expect(dying.adapter.state()).toBe("lost");
	expect(await dying.adapter.dispatch(CLICK, NEVER)).toEqual({
		status: "not_dispatched",
		code: "not_open",
		retryable: false,
	});
	await expect(dying.adapter.observe(NEVER)).rejects.toMatchObject({
		code: "not_open",
		dispatched: false,
	});
});

test("an abort cancels the call; one before the send never reaches the child", async () => {
	const ctx = await opened();
	await ctx.adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	ctx.fake.onTool = hang;
	const controller = new AbortController();
	const pending = ctx.adapter.dispatch(CLICK, controller.signal);
	await Bun.sleep(20);
	controller.abort();
	expect(await pending).toEqual({
		status: "indeterminate",
		code: "cancelled",
		retryable: false,
	});
	const before = ctx.fake.calls().length;
	const early = new AbortController();
	early.abort();
	expect(await ctx.adapter.dispatch(CLICK, early.signal)).toEqual({
		status: "not_dispatched",
		code: "cancelled",
		retryable: true,
	});
	expect(ctx.fake.calls().length).toBe(before);
});

test("targets are the tabs with their stable t<N> ids; a new tab before the browser exists is the first open", async () => {
	const { adapter, fake } = await opened();
	expect(await adapter.newTarget("https://a.test/", NEVER)).toEqual([
		{
			targetRef: "t1",
			kind: "tab",
			current: true,
			url: "https://a.test/",
			title: "A",
		},
		{
			targetRef: "t2",
			kind: "tab",
			current: false,
			url: "https://b.test/",
			title: "B",
		},
	]);
	expect(fake.calls().map((c) => c.name)).toEqual([
		"agent_browser_open",
		"agent_browser_open",
		"agent_browser_get_url",
		"agent_browser_tab_list",
	]);
	await adapter.selectTarget("t2", NEVER);
	await adapter.listTargets(NEVER);
	expect(
		fake
			.calls()
			.slice(4)
			.map((c) => [c.name, c.arguments]),
	).toEqual([
		["agent_browser_tab_switch", { tab: "t2" }],
		["agent_browser_tab_list", {}],
		["agent_browser_tab_list", {}],
	]);
	const before = fake.calls().length;
	for (const ref of ["1", "t", "docs", "t1; x", "-1", ""])
		await expect(adapter.selectTarget(ref, NEVER)).rejects.toMatchObject({
			code: "invalid_target",
			dispatched: false,
		});
	for (const url of ["file:///etc/passwd", "nope"])
		await expect(adapter.newTarget(url, NEVER)).rejects.toMatchObject({
			code: "invalid_url",
		});
	expect(fake.calls().length).toBe(before);
	// A list in a form that is not recognised is an error, never a guess.
	fake.onTool = () => text("t1 * https://a.test/ A");
	await expect(adapter.listTargets(NEVER)).rejects.toMatchObject({
		code: "mcp_response_unrecognized",
		dispatched: false,
	});
	fake.onTool = () =>
		text(
			JSON.stringify({
				data: { tabs: [{ id: "t3", url: "u", title: "", active: false }] },
			}),
		);
	expect(await adapter.listTargets(NEVER)).toEqual([
		{ targetRef: "t3", kind: "tab", current: false, url: "u" },
	]);
});

test("the first navigation, which launches the browser, ends on the requested url and is observed there", async () => {
	for (const behaviour of [
		{},
		// Even a launch that would ignore its url cannot leave the tab blank: the url is not sent with it.
		{ launchIgnoresUrl: true },
	]) {
		const { adapter, fake } = await opened();
		const live = liveTabs(fake, defaultTool, { launched: false, ...behaviour });
		expect(
			await adapter.dispatch(
				{ action: "browser.navigate", url: "https://slashdot.org/" },
				NEVER,
			),
		).toEqual({
			status: "confirmed",
			retryable: false,
			url: "https://slashdot.org/",
			title: "Page",
		});
		expect(live.commandUrl()).toBe("https://slashdot.org/");
		expect(await adapter.observe(NEVER)).toMatchObject({
			url: "https://slashdot.org/",
			title: "Page",
		});
		expect(await adapter.listTargets(NEVER)).toEqual([
			{
				targetRef: "t1",
				kind: "tab",
				current: true,
				url: "https://slashdot.org/",
				title: "Page",
			},
		]);
		// Launch (blank), navigate, then the page is read after the open returned.
		expect(
			fake
				.calls()
				.slice(0, 4)
				.map((c) => c.name),
		).toEqual([
			"agent_browser_open",
			"agent_browser_open",
			"agent_browser_get_url",
			"agent_browser_get_title",
		]);
	}
});

test("a navigation that leaves the tab blank is indeterminate, never confirmed", async () => {
	const { adapter, fake } = await opened();
	liveTabs(fake, defaultTool, { launched: false, neverNavigates: true });
	const calls = () =>
		fake.calls().filter((c) => c.name === "agent_browser_open");
	expect(
		await adapter.dispatch(
			{ action: "browser.navigate", url: "https://slashdot.org/" },
			NEVER,
		),
	).toEqual({
		status: "indeterminate",
		code: "navigation_not_committed",
		retryable: false,
	});
	// Not re-sent: the launch and the one navigation.
	expect(calls()).toHaveLength(2);
	// The same on a running browser, and for a new tab.
	expect(
		await adapter.dispatch(
			{ action: "browser.navigate", url: "https://slashdot.org/" },
			NEVER,
		),
	).toMatchObject({
		status: "indeterminate",
		code: "navigation_not_committed",
	});
	await expect(
		adapter.newTarget("https://slashdot.org/", NEVER),
	).rejects.toMatchObject({
		code: "navigation_not_committed",
		dispatched: true,
	});
	const first = setup();
	await first.adapter.open(NEVER);
	liveTabs(first.fake, defaultTool, { launched: false, neverNavigates: true });
	await expect(
		first.adapter.newTarget("https://slashdot.org/", NEVER),
	).rejects.toMatchObject({ code: "navigation_not_committed" });
});

test("a failure of the launch call means the command was never sent", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = (name) =>
		name === "agent_browser_open"
			? failure("browser executable not found")
			: text("ok");
	expect(
		await adapter.dispatch(
			{ action: "browser.navigate", url: "https://a.test/" },
			NEVER,
		),
	).toEqual({ status: "not_dispatched", code: "mcp_error", retryable: false });
	expect(fake.calls().map((c) => c.name)).toEqual(["agent_browser_open"]);
});

const LOAD_TIMEOUT =
	"Operation timed out. The page may still be loading or the element may not exist.";
/**
 * The tab behaviour of the real server, as seen in a raw session: `tab_new` with a url marks the new
 * tab active and shows the url in the list, but navigates later and leaves the commands on the old tab
 * (a switch then shows about:blank again); `tab_switch` and `open` act on the command tab.
 */
function liveTabs(
	fake: FakeSession,
	fallback: ToolHandler = () => text("ok"),
	behaviour: {
		/** False: no browser until the first open, which launches it (and navigates when it has a url). */
		launched?: boolean;
		/** The call that launches the browser ignores its url. */
		launchIgnoresUrl?: boolean;
		/** Open answers but never navigates. */
		neverNavigates?: boolean;
	} = {},
) {
	type Tab = { tabId: string; url: string; title: string; active: boolean };
	let launched = behaviour.launched ?? true;
	let tabs: Tab[] = launched
		? [{ tabId: "t1", url: "about:blank", title: "", active: true }]
		: [];
	let command = "t1";
	let next = 2;
	const commandTab = () => tabs.find((tab) => tab.tabId === command);
	fake.onTool = (name, args) => {
		switch (name) {
			case "agent_browser_tab_new": {
				const tabId = `t${next++}`;
				const url = typeof args.url === "string" ? args.url : "about:blank";
				tabs = [
					...tabs.map((tab) => ({ ...tab, active: false })),
					{ tabId, url, title: "", active: true },
				];
				return text(url);
			}
			case "agent_browser_tab_switch":
				command = String(args.tab);
				tabs = tabs.map((tab) => ({
					...tab,
					active: tab.tabId === command,
					...(tab.tabId === command ? { url: "about:blank" } : {}),
				}));
				return text("ok");
			case "agent_browser_open": {
				const launching = !launched;
				if (launching) {
					launched = true;
					tabs = [{ tabId: "t1", url: "about:blank", title: "", active: true }];
				}
				const navigates =
					typeof args.url === "string" &&
					!behaviour.neverNavigates &&
					!(launching && behaviour.launchIgnoresUrl);
				if (navigates)
					tabs = tabs.map((tab) =>
						tab.tabId === command
							? { ...tab, url: String(args.url), title: "Page" }
							: tab,
					);
				return text(navigates ? "Page" : "(no output)");
			}
			case "agent_browser_get_url":
				return text(commandTab()?.url ?? "");
			case "agent_browser_get_title":
				return text(commandTab()?.title ?? "");
			case "agent_browser_tab_list":
				return text(JSON.stringify({ data: { tabs } }, null, 2));
			default:
				return fallback(name, args);
		}
	};
	return {
		commandUrl: () => commandTab()?.url,
		/** The tab list the server shows, replaced by a test. */
		setTabs: (replacement: Tab[]) => {
			tabs = replacement;
		},
	};
}

test("a new tab is made empty, switched to, then opened on the url: the commands go to it", async () => {
	const { adapter, fake } = await opened();
	const live = liveTabs(fake);
	await adapter.listTargets(NEVER);
	const before = fake.calls().length;
	const targets = await adapter.newTarget("https://a.test/", NEVER);
	expect(
		fake
			.calls()
			.slice(before)
			.map((c) => [c.name, c.arguments]),
	).toEqual([
		["agent_browser_tab_list", {}],
		["agent_browser_tab_new", {}],
		["agent_browser_tab_list", {}],
		["agent_browser_tab_switch", { tab: "t2" }],
		["agent_browser_open", { url: "https://a.test/", timeoutMs: 45_000 }],
		["agent_browser_get_url", {}],
		["agent_browser_tab_list", {}],
	]);
	expect(targets.map((t) => [t.targetRef, t.current, t.url])).toEqual([
		["t1", false, "about:blank"],
		["t2", true, "https://a.test/"],
	]);
	// The commands are on the new tab: the next observation is of it.
	expect(live.commandUrl()).toBe("https://a.test/");
	expect(await adapter.observe(NEVER)).toMatchObject({
		url: "https://a.test/",
		title: "Page",
	});
	// selectTarget always switches, even to the tab the list calls active.
	const again = fake.calls().length;
	await adapter.selectTarget("t2", NEVER);
	expect(
		fake
			.calls()
			.slice(again)
			.map((c) => [c.name, c.arguments]),
	).toEqual([
		["agent_browser_tab_switch", { tab: "t2" }],
		["agent_browser_tab_list", {}],
	]);
});

test("a new tab that cannot be told apart from the list is an error that may have changed state", async () => {
	const { adapter, fake } = await opened();
	const live = liveTabs(fake);
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	const base = fake.onTool;
	const tab = (tabId: string) => ({
		tabId,
		url: "about:blank",
		title: "",
		active: false,
	});
	// No new id after tab_new, or two of them.
	for (const added of [[], [tab("t8"), tab("t9")]]) {
		fake.onTool = (name, args) => {
			if (name === "agent_browser_tab_new") {
				live.setTabs([tab("t1"), ...added]);
				return text("ok");
			}
			return base(name, args);
		};
		live.setTabs([tab("t1")]);
		const calls = fake.calls().length;
		await expect(
			adapter.newTarget("https://b.test/", NEVER),
		).rejects.toMatchObject({
			code: "mcp_response_unrecognized",
			dispatched: true,
		});
		// Nothing was switched to or opened.
		expect(
			fake
				.calls()
				.slice(calls)
				.map((c) => c.name),
		).toEqual([
			"agent_browser_tab_list",
			"agent_browser_tab_new",
			"agent_browser_tab_list",
		]);
	}
});

test("a new tab whose open outlasts the deadline is accepted only when the tab is on the page", async () => {
	for (const committed of [true, false]) {
		const { adapter, fake } = await opened();
		liveTabs(fake);
		await adapter.dispatch(
			{ action: "browser.navigate", url: "https://a.test/" },
			NEVER,
		);
		const base = fake.onTool;
		fake.onTool = (name, args) => {
			if (
				name !== "agent_browser_open" ||
				args.url !== "https://www.Gizmodo.jp"
			)
				return base(name, args);
			// The page is slow: the navigation commits (or not), and open reports its deadline.
			if (committed) base(name, args);
			return failure(LOAD_TIMEOUT);
		};
		const result = adapter.newTarget("https://www.Gizmodo.jp", NEVER);
		if (committed) {
			const targets = await result;
			expect(targets.find((t) => t.current)?.url).toBe(
				"https://www.Gizmodo.jp",
			);
		} else
			await expect(result).rejects.toMatchObject({
				code: "operation_timeout",
				dispatched: true,
			});
		// The open is never re-sent.
		expect(
			fake
				.calls()
				.filter(
					(c) =>
						c.name === "agent_browser_open" &&
						c.arguments.url === "https://www.Gizmodo.jp",
				),
		).toHaveLength(1);
	}
});

const NAVIGATE: AdapterCommand = {
	action: "browser.navigate",
	url: "https://www.Gizmodo.jp",
};

test("an open that times out on a heavy page is checked against the page's url, and never re-sent", async () => {
	const { adapter, fake } = await opened();
	// The browser is running (the launch open is not the one that times out).
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://warm.test/" },
		NEVER,
	);
	const run = async (url: () => ReturnType<typeof text>) => {
		fake.onTool = (name) =>
			name === "agent_browser_open"
				? failure(LOAD_TIMEOUT)
				: name === "agent_browser_get_url"
					? url()
					: name === "agent_browser_get_title"
						? text("Gizmodo")
						: text("ok");
		const before = fake.calls().length;
		const result = await adapter.dispatch(NAVIGATE, NEVER);
		const opens = fake
			.calls()
			.slice(before)
			.filter((c) => c.name === "agent_browser_open");
		expect(opens).toHaveLength(1);
		return result;
	};
	// The tab is on the requested page (scheme and host in lower case, empty path = "/"): committed, load incomplete.
	expect(await run(() => text("https://www.gizmodo.jp/"))).toEqual({
		status: "confirmed",
		code: "load_timeout",
		retryable: false,
		url: "https://www.gizmodo.jp/",
		title: "Gizmodo",
	});
	// Default port and a fragment make no difference; a different path, query or host does.
	expect(
		await run(() => text("https://www.gizmodo.jp:443/#top")),
	).toMatchObject({
		status: "confirmed",
		code: "load_timeout",
	});
	for (const other of [
		"https://www.gizmodo.jp/news",
		"https://www.gizmodo.jp/?q=1",
		"https://other.test/",
		"http://www.gizmodo.jp/",
		"about:blank",
	])
		expect(await run(() => text(other)), other).toEqual({
			status: "indeterminate",
			code: "operation_timeout",
			retryable: false,
		});
	// A state check that cannot be read leaves it indeterminate.
	expect(await run(() => failure("Unknown ref"))).toEqual({
		status: "indeterminate",
		code: "operation_timeout",
		retryable: false,
	});
	expect(await run(() => text("not a url"))).toMatchObject({
		status: "indeterminate",
	});
});

test("only a navigation's open gets the load-timeout check; other timeouts stay as they are", async () => {
	const { adapter, fake } = await opened();
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	fake.onTool = (name) =>
		name === "agent_browser_click"
			? failure(LOAD_TIMEOUT)
			: text("https://a.test/");
	expect(await adapter.dispatch(CLICK, NEVER)).toEqual({
		status: "indeterminate",
		code: "operation_timeout",
		retryable: false,
	});
	// The phrase later in the text, or in page-derived text, is not the error.
	fake.onTool = (name) =>
		name === "agent_browser_open"
			? failure(`Failed: ${LOAD_TIMEOUT}`)
			: text("https://a.test/");
	expect(
		await adapter.dispatch(
			{ action: "browser.navigate", url: "https://a.test/" },
			NEVER,
		),
	).toMatchObject({ status: "indeterminate", code: "mcp_error" });
});

test("a click, key or submit lets the page settle before the url is read; a failed settle changes nothing", async () => {
	const { adapter, fake } = await opened();
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	// The url is only the new page after the load wait: the order is what matters.
	let loaded = false;
	fake.onTool = (name) => {
		if (name === "agent_browser_wait_for_load") loaded = true;
		return name === "agent_browser_get_url"
			? text(loaded ? "https://a.test/product" : "https://a.test/")
			: text("ok");
	};
	const sequence = async (command: AdapterCommand) => {
		const before = fake.calls().length;
		loaded = false;
		const result = await adapter.dispatch(command, NEVER);
		return {
			result,
			names: fake
				.calls()
				.slice(before)
				.map((c) => c.name),
		};
	};
	const click = await sequence(CLICK);
	expect(click.names).toEqual([
		"agent_browser_click",
		"agent_browser_wait_for_load",
		"agent_browser_get_url",
		"agent_browser_get_title",
	]);
	expect(click.result).toMatchObject({
		status: "confirmed",
		url: "https://a.test/product",
	});
	expect(
		(await sequence({ action: "page.press", key: "Enter" })).names,
	).toEqual([
		"agent_browser_press",
		"agent_browser_wait_for_load",
		"agent_browser_get_url",
		"agent_browser_get_title",
	]);
	expect(
		(
			await sequence({
				action: "page.fill",
				targetRef: "e1",
				element: "q",
				text: "x",
				submit: true,
			})
		).names,
	).toEqual([
		"agent_browser_fill",
		"agent_browser_press",
		"agent_browser_wait_for_load",
		"agent_browser_get_url",
		"agent_browser_get_title",
	]);
	// No settle wait for a fill without submit, a select, a scroll or a navigation (open waits itself).
	for (const command of [
		{
			action: "page.fill",
			targetRef: "e1",
			element: "q",
			text: "x",
			submit: false,
		},
		{ action: "page.select", targetRef: "e1", element: "q", values: ["a"] },
		{ action: "page.scroll", direction: "down" },
		{ action: "browser.navigate", url: "https://a.test/" },
		{ action: "browser.back" },
	] as AdapterCommand[])
		expect((await sequence(command)).names).not.toContain(
			"agent_browser_wait_for_load",
		);
	// A timeout (or any failure) of the settle wait only means the url is read now.
	fake.onTool = (name) =>
		name === "agent_browser_wait_for_load"
			? failure(
					"Operation timed out. The page may still be loading or the element may not exist.",
				)
			: name === "agent_browser_get_url"
				? text("https://a.test/")
				: text("ok");
	expect(await adapter.dispatch(CLICK, NEVER)).toMatchObject({
		status: "confirmed",
		url: "https://a.test/",
	});
	const slow = await opened({ callTimeoutMs: 40 });
	await slow.adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	slow.fake.onTool = (name) =>
		name === "agent_browser_wait_for_load" ? hang() : text("ok");
	expect(await slow.adapter.dispatch(CLICK, NEVER)).toMatchObject({
		status: "confirmed",
	});
	// A server without the tool simply skips the wait.
	const slim = await opened({
		tools: CORE_TABS.filter((n) => n !== "agent_browser_wait_for_load"),
	});
	await slim.adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	expect(await slim.adapter.dispatch(CLICK, NEVER)).toMatchObject({
		status: "confirmed",
	});
});

const FACTS = {
	tag: "button",
	type: "submit",
	inForm: true,
	formMethod: "post",
	submits: true,
};

test("inspectFocused runs the fixed script; a ref cannot be inspected without get_box", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = () => text(JSON.stringify(FACTS));
	expect(await adapter.inspect("inspectFocused", null, NEVER)).toEqual(FACTS);
	// The tool may quote what the script returns.
	fake.onTool = () => text(JSON.stringify(JSON.stringify(FACTS)));
	expect(await adapter.inspect("inspectFocused", null, NEVER)).toEqual(FACTS);
	expect(
		fake
			.calls()
			.filter((c) => c.name === "agent_browser_eval")
			.map((c) => c.arguments),
	).toEqual([
		{ script: INSPECT_FOCUSED_SCRIPT },
		{ script: INSPECT_FOCUSED_SCRIPT },
	]);
	expect(INSPECT_FOCUSED_SCRIPT).not.toMatch(/\be4\b|http|eumenes/i);
	const before = fake.calls().length;
	for (const ref of ["e4", null])
		await expect(
			adapter.inspect("inspectTarget", ref, NEVER),
		).rejects.toMatchObject({
			code: "unsupported",
			dispatched: false,
		});
	// Both need `get_box`, which core and tabs do not have.
	await expect(
		adapter.inspect("inspectLocator", "e4", NEVER),
	).rejects.toMatchObject({
		code: "unsupported",
	});
	await expect(
		adapter.inspect("bogus" as never, null, NEVER),
	).rejects.toMatchObject({
		code: "unsupported",
	});
	expect(fake.calls().length).toBe(before);
	fake.onTool = () => text('{"tag":"button","inForm":"yes","submits":1}');
	await expect(
		adapter.inspect("inspectFocused", null, NEVER),
	).rejects.toMatchObject({
		code: "inspect_invalid",
		dispatched: false,
	});
	fake.onTool = () => failure("boom");
	await expect(
		adapter.inspect("inspectFocused", null, NEVER),
	).rejects.toMatchObject({
		dispatched: false,
	});
});

const WITH_BOX = [...CORE_TABS, "agent_browser_get_box"];
const BOX = { x: 306, y: 17, width: 423, height: 32 };
/** `get_box` as the real tool prints it. */
const boxAnswer = (box: object = BOX) =>
	text(
		JSON.stringify(
			{ data: { ...box, lifecycle: {} }, error: null, success: true },
			null,
			2,
		),
	);
/** What the eval tool returns for a script that returns JSON text: that text, JSON-encoded. */
const evalAnswer = (value: unknown) =>
	text(JSON.stringify(JSON.stringify(value)));

test("inspectTarget finds the element again by its box and runs the fixed function on it", async () => {
	const { adapter, fake } = await opened({ tools: WITH_BOX });
	fake.onTool = (name) =>
		name === "agent_browser_get_box"
			? boxAnswer()
			: evalAnswer({ match: true, value: FACTS });
	expect(await adapter.inspect("inspectTarget", "e4", NEVER)).toEqual(FACTS);
	expect(
		fake
			.calls()
			.slice(1)
			.map((c) => [c.name, c.arguments]),
	).toEqual([
		["agent_browser_get_box", { selector: "@e4" }],
		[
			"agent_browser_eval",
			{ script: locateScript(INSPECT_TARGET_FUNCTION, BOX) },
		],
	]);
	// The script is fixed text with the four validated numbers and the probe point: nothing else.
	const script = locateScript(INSPECT_TARGET_FUNCTION, BOX);
	expect(script).toContain(
		'const box = {"x":306,"y":17,"width":423,"height":32};',
	);
	expect(script).toContain("const px = 314;");
	expect(script).toContain("const py = 25;");
	expect(script).toContain(`const run = ${INSPECT_TARGET_FUNCTION};`);
	expect(script).not.toMatch(/\be4\b|@e4|http|eumenes/i);
	// A box of another size gives another script and only the numbers differ.
	const other = locateScript(INSPECT_TARGET_FUNCTION, {
		x: 1.5,
		y: 2,
		width: 5,
		height: 4,
	});
	expect(other.replace(/-?\d+(\.\d+)?/g, "N")).toBe(
		script.replace(/-?\d+(\.\d+)?/g, "N"),
	);
});

test("inspectLocator runs its fixed function the same way", async () => {
	const { adapter, fake } = await opened({ tools: WITH_BOX });
	const facts = {
		tag: "input",
		type: "email",
		name: "mail",
		id: null,
		placeholder: "you@example.com",
		"aria-label": null,
		"data-testid": "mail-input",
		role: null,
		autocomplete: "email",
		formId: "signup",
		formName: null,
		formMethod: "post",
	};
	fake.onTool = (name) =>
		name === "agent_browser_get_box"
			? boxAnswer()
			: evalAnswer({ match: true, value: facts });
	expect(await adapter.inspect("inspectLocator", "f1e7", NEVER)).toEqual(facts);
	expect(fake.calls().at(-1)?.arguments).toEqual({
		script: locateScript(INSPECT_LOCATOR_FUNCTION, BOX),
	});
	await expect(
		adapter.inspect("inspectLocator", "a > b", NEVER),
	).rejects.toMatchObject({ code: "invalid_ref", dispatched: false });
});

test("an element that cannot be found again is unsupported, never guessed", async () => {
	const { adapter, fake } = await opened({ tools: WITH_BOX });
	// The script found no element with that rectangle (covered, off-screen, other coordinates).
	fake.onTool = (name) =>
		name === "agent_browser_get_box"
			? boxAnswer()
			: evalAnswer({ match: false });
	for (const kind of ["inspectTarget", "inspectLocator"] as const)
		await expect(adapter.inspect(kind, "e4", NEVER)).rejects.toMatchObject({
			code: "unsupported",
			dispatched: false,
		});
	// A box that is not a usable box ends before the script runs.
	const unusable = [
		'{"x":1,"y":1,"width":0,"height":5}',
		'{"x":1,"y":1,"width":5,"height":-5}',
		'{"x":1,"y":1,"width":"5","height":5}',
		'{"x":null,"y":1,"width":5,"height":5}',
		'{"x":1e999,"y":1,"width":5,"height":5}',
		'{"x":1,"y":1,"width":5,"height":1e9}',
		'{"y":1,"width":5,"height":5}',
	];
	for (const box of unusable) {
		fake.onTool = (name) =>
			name === "agent_browser_get_box"
				? text(`{"data":${box},"error":null,"success":true}`)
				: evalAnswer({ match: true, value: FACTS });
		const before = fake.calls().length;
		await expect(
			adapter.inspect("inspectTarget", "e4", NEVER),
		).rejects.toMatchObject({ code: "unsupported" });
		// Only get_box was called: the script never ran.
		expect(fake.calls().length - before, box).toBe(1);
	}
	// Not JSON, or an error from the tool (a ref that is gone keeps its own code).
	fake.onTool = () => text("no box");
	await expect(
		adapter.inspect("inspectTarget", "e4", NEVER),
	).rejects.toMatchObject({
		code: "unsupported",
	});
	fake.onTool = () => failure("Unknown ref: e99999");
	await expect(
		adapter.inspect("inspectTarget", "e99999", NEVER),
	).rejects.toMatchObject({
		code: "stale_ref",
		dispatched: false,
	});
	// A script answer in an unknown form is an error.
	fake.onTool = (name) =>
		name === "agent_browser_get_box" ? boxAnswer() : evalAnswer({ nothing: 1 });
	await expect(
		adapter.inspect("inspectTarget", "e4", NEVER),
	).rejects.toMatchObject({
		code: "mcp_response_unrecognized",
		dispatched: false,
	});
	fake.onTool = (name) =>
		name === "agent_browser_get_box"
			? boxAnswer()
			: evalAnswer({ match: true, value: { tag: "button", inForm: "yes" } });
	await expect(
		adapter.inspect("inspectTarget", "e4", NEVER),
	).rejects.toMatchObject({
		code: "inspect_invalid",
	});
});

test("without get_box or eval, a ref cannot be inspected and nothing is sent", async () => {
	for (const tools of [
		CORE_TABS,
		WITH_BOX.filter((n) => n !== "agent_browser_eval"),
	]) {
		const { adapter, fake } = await opened({ tools });
		for (const kind of ["inspectTarget", "inspectLocator"] as const)
			await expect(adapter.inspect(kind, "e4", NEVER)).rejects.toMatchObject({
				code: "unsupported",
			});
		expect(fake.calls()).toEqual([]);
	}
});

const extracted = (over: Record<string, unknown> = {}) => ({
	url: "https://a.test/post",
	title: "Post",
	text: "Para one\n\nPara two",
	charCount: 18,
	root: "article",
	...over,
});

test("extract without a ref runs the same fixed function through eval", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = () => text(JSON.stringify(extracted()));
	expect(await adapter.extract(null, 1000, NEVER)).toEqual({
		url: "https://a.test/post",
		title: "Post",
		text: "Para one\n\nPara two",
		charCount: 18,
		truncated: false,
		root: "article",
	});
	// Quoted result, cap and hard bound behave as on Playwright MCP.
	fake.onTool = () =>
		text(
			JSON.stringify(
				JSON.stringify(extracted({ text: "x".repeat(100), charCount: 100 })),
			),
		);
	expect(await adapter.extract(null, 10, NEVER)).toMatchObject({
		text: "x".repeat(10),
		charCount: 100,
		truncated: true,
	});
	fake.onTool = () =>
		text(
			JSON.stringify(
				extracted({
					text: "y".repeat(EXTRACT_HARD_MAX_CHARS),
					charCount: EXTRACT_HARD_MAX_CHARS + 5,
				}),
			),
		);
	const hard = await adapter.extract(null, 10_000_000, NEVER);
	expect(hard.text).toHaveLength(EXTRACT_HARD_MAX_CHARS);
	expect(hard.truncated).toBe(true);
	expect(
		fake
			.calls()
			.filter((c) => c.name === "agent_browser_eval")
			.map((c) => c.arguments),
	).toEqual([
		{ script: EXTRACT_SCRIPT },
		{ script: EXTRACT_SCRIPT },
		{ script: EXTRACT_SCRIPT },
	]);
	expect(EXTRACT_SCRIPT).toContain("largest-block");
	const before = fake.calls().length;
	for (const max of [0, 1.5, Number.NaN])
		await expect(adapter.extract(null, max, NEVER)).rejects.toMatchObject({
			code: "invalid_max_chars",
		});
	expect(fake.calls().length).toBe(before);
});

test("extract rejects malformed answers and a root that does not fit the request", async () => {
	const { adapter, fake } = await opened();
	for (const answer of [
		"oops",
		"[]",
		JSON.stringify(extracted({ extra: 1 })),
		JSON.stringify(extracted({ root: "footer" })),
		JSON.stringify(extracted({ root: "target" })),
		JSON.stringify(extracted({ charCount: 3 })),
		JSON.stringify(extracted({ text: 5 })),
	]) {
		fake.onTool = () => text(answer);
		await expect(
			adapter.extract(null, 100, NEVER),
			answer,
		).rejects.toMatchObject({
			code: "mcp_response_unrecognized",
			dispatched: false,
		});
	}
});

test("extract with a ref but without get_box reads the element's text and normalises it; nothing inside is dropped", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = (name) =>
		name === "agent_browser_get_text"
			? text("  Product   title \n\n\n\n Price:  100  \n description ")
			: name === "agent_browser_get_url"
				? text("https://a.test/item")
				: name === "agent_browser_get_title"
					? text("Item")
					: text("ok");
	expect(await adapter.extract("e9", 1000, NEVER)).toEqual({
		url: "https://a.test/item",
		title: "Item",
		text: "Product title\n\nPrice: 100\ndescription",
		charCount: 37,
		truncated: false,
		root: "target",
	});
	expect(
		fake.calls().find((c) => c.name === "agent_browser_get_text")?.arguments,
	).toEqual({
		selector: "@e9",
	});
	expect(await adapter.extract("e9", 7, NEVER)).toMatchObject({
		text: "Product",
		truncated: true,
	});
	// No eval for an element: the fixed function cannot run on a ref here.
	expect(fake.calls().some((c) => c.name === "agent_browser_eval")).toBe(false);
	const before = fake.calls().length;
	for (const ref of ["a > b", "@e1", ""])
		await expect(adapter.extract(ref, 100, NEVER)).rejects.toMatchObject({
			code: "invalid_ref",
			dispatched: false,
		});
	expect(fake.calls().length).toBe(before);
	// Page and url that cannot be read are left out.
	fake.onTool = (name) =>
		name === "agent_browser_get_text" ? text("Body") : failure("x");
	const bare = await adapter.extract("e9", 100, NEVER);
	expect(bare).not.toHaveProperty("url");
	expect(bare).not.toHaveProperty("title");
});

test("extract with a ref runs the same function on the element found by its box; otherwise it falls back to its text", async () => {
	const { adapter, fake } = await opened({ tools: WITH_BOX });
	const onTarget = extracted({
		root: "target",
		text: "Item body",
		charCount: 9,
	});
	fake.onTool = (name) =>
		name === "agent_browser_get_box"
			? boxAnswer()
			: evalAnswer({ match: true, value: onTarget });
	expect(await adapter.extract("e9", 1000, NEVER)).toEqual({
		url: "https://a.test/post",
		title: "Post",
		text: "Item body",
		charCount: 9,
		truncated: false,
		root: "target",
	});
	expect(
		fake
			.calls()
			.slice(1)
			.map((c) => [c.name, c.arguments]),
	).toEqual([
		["agent_browser_get_box", { selector: "@e9" }],
		[
			"agent_browser_eval",
			{ script: locateScript(EXTRACT_TARGET_FUNCTION, BOX) },
		],
	]);
	// A root other than `target` from the element path is not accepted.
	fake.onTool = (name) =>
		name === "agent_browser_get_box"
			? boxAnswer()
			: evalAnswer({ match: true, value: extracted({ root: "article" }) });
	await expect(adapter.extract("e9", 1000, NEVER)).rejects.toMatchObject({
		code: "mcp_response_unrecognized",
	});

	// Not found again by its box: the element's own text.
	fake.onTool = (name) =>
		name === "agent_browser_get_box"
			? boxAnswer()
			: name === "agent_browser_eval"
				? evalAnswer({ match: false })
				: name === "agent_browser_get_text"
					? text(" Fallback   text ")
					: text("ok");
	const before = fake.calls().length;
	expect(await adapter.extract("e9", 1000, NEVER)).toMatchObject({
		text: "Fallback text",
		root: "target",
	});
	expect(
		fake
			.calls()
			.slice(before)
			.map((c) => c.name),
	).toEqual([
		"agent_browser_get_box",
		"agent_browser_eval",
		"agent_browser_get_text",
		"agent_browser_get_url",
		"agent_browser_get_title",
	]);
	// A box that is not usable: no script, straight to the text.
	fake.onTool = (name) =>
		name === "agent_browser_get_box"
			? text("{}")
			: name === "agent_browser_get_text"
				? text("Plain")
				: text("ok");
	const again = fake.calls().length;
	expect(await adapter.extract("e9", 1000, NEVER)).toMatchObject({
		text: "Plain",
	});
	expect(
		fake
			.calls()
			.slice(again)
			.some((c) => c.name === "agent_browser_eval"),
	).toBe(false);
	// A ref that is gone is an error, not a reason to read other text.
	fake.onTool = () => failure("Unknown ref: e9");
	await expect(adapter.extract("e9", 1000, NEVER)).rejects.toMatchObject({
		code: "stale_ref",
		dispatched: false,
	});
});

test("a JSON-RPC rejection is not dispatched: the call was refused before it acted", async () => {
	const { adapter, fake } = await opened();
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	fake.transportError = new McpTransportError("rpc_error", true, -32602);
	expect(await adapter.dispatch(CLICK, NEVER)).toEqual({
		status: "not_dispatched",
		code: "mcp_protocol_error",
		retryable: false,
	});
});

test("extract stops on abort and refuses when the session is not open", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = hang;
	const controller = new AbortController();
	const pending = adapter.extract(null, 100, controller.signal);
	await Bun.sleep(20);
	controller.abort();
	await expect(pending).rejects.toMatchObject({
		code: "cancelled",
		dispatched: false,
	});
	await adapter.close();
	await expect(adapter.extract(null, 100, NEVER)).rejects.toMatchObject({
		code: "not_open",
	});
});

test("only allowlisted tools are sent, and eval runs only the adapter's own fixed scripts", async () => {
	for (const name of [
		"agent_browser_hover",
		"agent_browser_type",
		"agent_browser_read",
		"agent_browser_network_route",
		"agent_browser_cookies_get",
		"agent_browser_upload",
		"agent_browser_screenshot",
		"agent_browser_connect",
	])
		expect(isAllowedTool(name)).toBe(false);
	expect(ALLOWED_AGENT_BROWSER_TOOLS.every(isAllowedTool)).toBe(true);
	const { adapter, fake } = await opened({
		tools: WITH_BOX,
	});
	liveTabs(fake, (name, args) =>
		name === "agent_browser_get_box"
			? boxAnswer()
			: name === "agent_browser_eval"
				? String(args.script).includes("const box")
					? evalAnswer({ match: true, value: extracted({ root: "target" }) })
					: text(JSON.stringify(extracted()))
				: text("ok"),
	);
	await adapter.observe(NEVER);
	await adapter.listTargets(NEVER);
	await adapter.newTarget("https://a.test/", NEVER);
	await adapter.selectTarget("t1", NEVER);
	await adapter.extract(null, 100, NEVER);
	await adapter.extract("e1", 100, NEVER);
	await adapter.inspect("inspectFocused", null, NEVER).catch(() => {});
	await adapter.inspect("inspectLocator", "e1", NEVER).catch(() => {});
	await adapter.inspect("inspectTarget", "e1", NEVER).catch(() => {});
	for (const command of [
		{ action: "browser.navigate", url: "https://a.test/" },
		{ action: "browser.back" },
		CLICK,
		{
			action: "page.fill",
			targetRef: "e1",
			element: "x",
			text: "t",
			submit: true,
		},
		{ action: "page.select", targetRef: "e1", element: "x", values: ["a"] },
		{ action: "page.press", key: "a" },
		{ action: "page.wait", seconds: 1, text: "x" },
		{ action: "page.scroll", direction: "down" },
		{ action: "page.hover", targetRef: "e1", element: "x" },
	] as AdapterCommand[])
		await adapter.dispatch(command, NEVER);
	for (const name of new Set(fake.toolNames()))
		expect(isAllowedTool(name)).toBe(true);
	const scripts = fake
		.calls()
		.filter((c) => c.name === "agent_browser_eval")
		.map((c) => c.arguments.script);
	expect(scripts.length).toBeGreaterThan(0);
	// The scripts without input, and the locate script around one of the three fixed functions.
	const allowed: string[] = [
		EXTRACT_SCRIPT,
		INSPECT_FOCUSED_SCRIPT,
		...[
			INSPECT_TARGET_FUNCTION,
			INSPECT_LOCATOR_FUNCTION,
			EXTRACT_TARGET_FUNCTION,
		].map((body) => locateScript(body, BOX)),
	];
	for (const script of scripts) expect(allowed).toContain(script as string);
	expect(scripts.filter((s) => String(s).includes("const box")).length).toBe(3);
	expect(Object.keys(adapter).sort()).toEqual(
		[
			"catalog",
			"close",
			"dispatch",
			"extract",
			"inspect",
			"listTargets",
			"newTarget",
			"observe",
			"open",
			"platform",
			"selectTarget",
			"state",
			"toolInfo",
		].sort(),
	);
});

test("calls run one at a time", async () => {
	const { adapter, fake } = await opened();
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	fake.onTool = async () => {
		await Bun.sleep(5);
		return text("ok");
	};
	await Promise.all([
		adapter.dispatch(CLICK, NEVER),
		adapter.dispatch(CLICK, NEVER),
		adapter.observe(NEVER),
	]);
	expect(fake.maxActive).toBe(1);
});

test("close closes the browser, then stops the child; it survives a failing close and is idempotent", async () => {
	const { adapter, fake, events, workDir } = await opened();
	await adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	writeFileSync(join(workDir, "host-trace.txt"), "keep");
	await Promise.all([adapter.close(), adapter.close()]);
	await adapter.close();
	expect(fake.calls().at(-1)).toEqual({
		name: "agent_browser_close",
		arguments: {},
	});
	expect(
		fake.calls().filter((c) => c.name === "agent_browser_close"),
	).toHaveLength(1);
	expect(fake.closeCount).toBe(1);
	expect(adapter.state()).toBe("closed");
	expect(existsSync(join(workDir, "host-trace.txt"))).toBe(true);
	expect(events.filter(([name]) => name === "adapter.closed")).toHaveLength(1);
	expect(await adapter.dispatch(CLICK, NEVER)).toMatchObject({
		code: "not_open",
	});

	// A close that fails or hangs still stops the child.
	for (const onClose of [() => failure("close failed"), hang]) {
		const ctx = await opened();
		await ctx.adapter.dispatch(
			{ action: "browser.navigate", url: "https://a.test/" },
			NEVER,
		);
		ctx.fake.onTool = (name) =>
			name === "agent_browser_close" ? onClose() : text("ok");
		await ctx.adapter.close();
		expect(ctx.fake.closeCount).toBe(1);
		expect(ctx.adapter.state()).toBe("closed");
	}

	// Nothing was launched, so there is no browser to close: only the child stops.
	const idle = await opened();
	await idle.adapter.close();
	expect(idle.fake.calls()).toEqual([]);
	expect(idle.fake.closeCount).toBe(1);
	const never = setup();
	await never.adapter.close();
	expect(never.launches).toHaveLength(0);
	expect(never.events).toEqual([]);
});

test("close lets a call in flight finish before it closes the browser, but not for long", async () => {
	const ctx = await opened({ closeWaitMs: 50 });
	await ctx.adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	ctx.fake.onTool = hang;
	const pending = ctx.adapter.dispatch(CLICK, NEVER);
	await Bun.sleep(10);
	await ctx.adapter.close();
	expect(ctx.fake.closeCount).toBe(1);
	expect(await pending).toMatchObject({ status: "indeterminate" });
});

test("a lost session can be closed and opened again with a new child", async () => {
	const ctx = await opened();
	ctx.fake.exit();
	await Bun.sleep(10);
	expect(ctx.adapter.state()).toBe("lost");
	await ctx.adapter.close();
	const next = new FakeSession();
	next.toolPages = [CORE_TABS];
	ctx.fake = next;
	await ctx.adapter.open(NEVER);
	expect(ctx.adapter.state()).toBe("open");
	expect(ctx.launches).toHaveLength(2);
});

test("logs carry only fixed names and fields, never page text, urls or values", async () => {
	const { adapter, fake, events } = await opened();
	fake.onTool = (name) =>
		name === "agent_browser_snapshot"
			? text("- text: SECRET-PAGE-TEXT")
			: name === "agent_browser_get_url"
				? text("https://secret.test/?token=SECRET-URL")
				: text("ok");
	await adapter.observe(NEVER);
	await adapter.dispatch(
		{
			action: "page.fill",
			targetRef: "e1",
			element: "x",
			text: "SECRET-VALUE",
			submit: false,
		},
		NEVER,
	);
	fake.onTool = () =>
		failure('Stale ref for role=button name="SECRET-NAME" cannot be recovered');
	await adapter.dispatch(CLICK, NEVER);
	await adapter.close();
	expect(events.map(([name]) => name)).toEqual([
		"adapter.opened",
		"adapter.observed",
		"adapter.dispatched",
		"adapter.failed",
		"adapter.closed",
	]);
	for (const [, fields] of events) {
		expect(
			Object.keys(fields).every((k) =>
				["correlationId", "code", "count", "durationMs"].includes(k),
			),
		).toBe(true);
	}
	expect(events[3]?.[1].code).toBe("stale_ref");
	expect(JSON.stringify(events)).not.toMatch(/SECRET/);
	// A logger that throws cannot break the adapter.
	const ctx = setup();
	const noisy = createAgentBrowserAdapter(
		{
			launch: { command: "/x", args: [] },
			workDir: ctx.workDir,
			logger: {
				event() {
					throw new Error("logger down");
				},
			},
			correlationId: "c",
			browser: { headless: true },
		},
		{ startSession: () => ctx.fake },
	);
	ctx.fake.toolPages = [CORE_TABS];
	await noisy.open(NEVER);
	expect(await noisy.dispatch(CLICK, NEVER)).toMatchObject({
		status: "confirmed",
	});
});
