import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPlaywrightMcpAdapter } from "../../../src/adapters/playwright-mcp/adapter.ts";
import {
	COMMON_ACTIONS,
	type AdapterCommand,
} from "../../../src/contracts/operation.ts";
import {
	ALLOWED_MCP_TOOLS,
	EXTRACT_HARD_MAX_CHARS,
	EXTRACT_PAGE_FUNCTION,
	EXTRACT_TARGET_FUNCTION,
	INSPECT_FOCUSED_FUNCTION,
	INSPECT_LOCATOR_FUNCTION,
	INSPECT_TARGET_FUNCTION,
} from "../../../src/adapters/playwright-mcp/index.ts";
import { isAllowedTool } from "../../../src/adapters/playwright-mcp/tools.ts";
import {
	BODY,
	cleanup,
	failure,
	FakeSession,
	hang,
	inlineSnapshot,
	NEVER,
	opened,
	PAGE,
	setup,
	tabs,
	text,
} from "./fakes.ts";

afterEach(cleanup);

const CLICK_NEVER_PERFORMED = `Error: locator.click: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('aria-ref=e9')
  - attempting click action
  -   waiting for element to be visible, enabled and stable
  -   element is not enabled
  -   retrying click action`;
const CLICK_PERFORMED = `Error: locator.click: Timeout 5000ms exceeded.
Call log:
  - attempting click action
  -   performing click action
  -   click action done`;
const NAME_NOT_RESOLVED = `Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.test/
Call log:
  - navigating to "https://x.test/", waiting until "domcontentloaded"`;

const CLICK: AdapterCommand = {
	action: "page.click",
	targetRef: "e4",
	element: "open",
};

test("open starts the host's executable with the fixed isolated flags and a minimal env", async () => {
	const { adapter, fake, launches, workDir } = setup({
		env: { PLAYWRIGHT_BROWSERS_PATH: "/browsers" },
		args: ["/fake/cli.js", "--browser", "chromium"],
	});
	expect(adapter.state()).toBe("closed");
	await adapter.open(NEVER);
	expect(adapter.state()).toBe("open");
	const outputDir = join(workDir, "playwright-mcp-output");
	const configPath = join(workDir, "playwright-mcp.config.json");
	expect(launches).toHaveLength(1);
	expect(launches[0]).toMatchObject({
		command: "/fake/node",
		args: [
			"/fake/cli.js",
			"--browser",
			"chromium",
			"--isolated",
			"--headless",
			"--output-dir",
			outputDir,
			"--no-webmcp",
			"--config",
			configPath,
		],
		cwd: outputDir,
	});
	expect(Object.keys(launches[0]?.env ?? {}).sort()).toEqual(
		["HOME", "PATH", "PLAYWRIGHT_BROWSERS_PATH"].sort(),
	);
	expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
		browser: { launchOptions: { args: ["--mute-audio"] } },
	});
	expect(fake.requests.map((r) => r.method)).toEqual([
		"initialize",
		"tools/call",
	]);
	expect(fake.notified).toEqual(["notifications/initialized"]);
	// The first tool call is the one that launches the browser.
	expect(fake.calls()[0]).toEqual({
		name: "browser_tabs",
		arguments: { action: "list" },
	});
	expect(adapter.toolInfo()).toEqual({
		name: "@playwright/mcp",
		version: "0.0.83",
	});
});

test("headed mode passes no --headless, and the version is null without serverInfo", async () => {
	const ctx = setup({ headless: false });
	ctx.fake.initializeResult = {};
	expect(ctx.adapter.toolInfo().version).toBeNull();
	await ctx.adapter.open(NEVER);
	expect(ctx.launches[0]?.args).not.toContain("--headless");
	expect(ctx.launches[0]?.args).toContain("--isolated");
	expect(ctx.adapter.toolInfo()).toEqual({
		name: "@playwright/mcp",
		version: null,
	});
});

test("headed mode passes the display through (only then); headless keeps it out", async () => {
	const saved = process.env.DISPLAY;
	process.env.DISPLAY = ":7";
	try {
		const headed = setup({ headless: false });
		await headed.adapter.open(NEVER);
		expect(headed.launches[0]?.env?.DISPLAY).toBe(":7");
		const headless = setup({ headless: true });
		await headless.adapter.open(NEVER);
		expect(headless.launches[0]?.env?.DISPLAY).toBeUndefined();
	} finally {
		if (saved === undefined) delete process.env.DISPLAY;
		else process.env.DISPLAY = saved;
	}
});

test("a launch that would attach to an existing browser is refused before anything starts", async () => {
	for (const ctx of [
		setup({ args: ["/fake/cli.js", "--extension"] }),
		setup({ args: ["/fake/cli.js", "--cdp-endpoint=http://127.0.0.1:9222"] }),
		setup({ env: { PLAYWRIGHT_MCP_USER_DATA_DIR: "/home/me/profile" } }),
	]) {
		await expect(ctx.adapter.open(NEVER)).rejects.toMatchObject({
			code: "launch_not_isolated",
			dispatched: false,
		});
		expect(ctx.launches).toHaveLength(0);
		expect(ctx.adapter.state()).toBe("closed");
	}
});

test("open failures stop the child and leave the adapter closed", async () => {
	const failing = setup();
	failing.fake.onTool = () => failure("browser executable not found");
	await expect(failing.adapter.open(NEVER)).rejects.toMatchObject({
		code: "mcp_unavailable",
		dispatched: false,
	});
	expect(failing.adapter.state()).toBe("closed");
	expect(failing.fake.closeCount).toBe(1);

	const slow = setup({ connectTimeoutMs: 50 });
	slow.fake.onTool = hang;
	await expect(slow.adapter.open(NEVER)).rejects.toMatchObject({
		code: "connect_timeout",
	});
	expect(slow.fake.closeCount).toBe(1);

	const aborting = setup();
	aborting.fake.onTool = hang;
	const controller = new AbortController();
	const pending = aborting.adapter.open(controller.signal);
	await Bun.sleep(20);
	expect(aborting.adapter.state()).toBe("opening");
	controller.abort();
	await expect(pending).rejects.toMatchObject({ code: "aborted" });
	expect(aborting.adapter.state()).toBe("closed");
	expect(aborting.fake.closeCount).toBe(1);

	const early = setup();
	const aborted = new AbortController();
	aborted.abort();
	await expect(early.adapter.open(aborted.signal)).rejects.toMatchObject({
		code: "aborted",
	});
	expect(early.launches).toHaveLength(0);
});

test("a close during open stops the child, or prevents it from starting", async () => {
	// Closed while open still awaits its directory setup: nothing may start afterwards.
	const early = setup();
	const pending = early.adapter.open(NEVER);
	const closing = early.adapter.close();
	await expect(pending).rejects.toMatchObject({
		code: "closed",
		dispatched: false,
	});
	await closing;
	expect(early.launches).toHaveLength(0);
	expect(early.adapter.state()).toBe("closed");

	// Closed while the child starts: it is stopped and the adapter stays closed.
	const late = setup();
	late.fake.onTool = hang;
	// Handled at once: the open fails while `close` is still running.
	const started = late.adapter.open(NEVER).then(
		() => undefined,
		(error: unknown) => error,
	);
	await Bun.sleep(20);
	expect(late.launches).toHaveLength(1);
	await late.adapter.close();
	expect(await started).toMatchObject({ dispatched: false });
	expect(late.fake.closeCount).toBeGreaterThanOrEqual(1);
	expect(late.fake.exited()).toBe(true);
	expect(late.adapter.state()).toBe("closed");

	// The same adapter opens normally afterwards.
	late.fake = new FakeSession();
	await late.adapter.open(NEVER);
	expect(late.adapter.state()).toBe("open");
});

test("a second open does not start another child", async () => {
	const ctx = await opened();
	await ctx.adapter.open(NEVER);
	expect(ctx.launches).toHaveLength(1);
});

test("the catalog marks only scroll unsupported and never claims physical input", () => {
	const { adapter } = setup();
	const catalog = adapter.catalog();
	expect(catalog.map((e) => e.action)).toEqual([...COMMON_ACTIONS]);
	expect(catalog.every((e) => e.platform === "playwright-mcp")).toBe(true);
	expect(catalog.some((e) => e.physicalInput)).toBe(false);
	expect(catalog.filter((e) => !e.supported).map((e) => e.action)).toEqual([
		"page.scroll",
	]);
	const byAction = Object.fromEntries(catalog.map((e) => [e.action, e]));
	expect(byAction["page.capture"]).toEqual({
		action: "page.capture",
		platform: "playwright-mcp",
		supported: true,
		needsTargetRef: false,
		physicalInput: false,
	});
	expect(byAction["page.extract"]).toEqual({
		action: "page.extract",
		platform: "playwright-mcp",
		supported: true,
		needsTargetRef: false,
		physicalInput: false,
	});
	expect(byAction["page.click"]?.needsTargetRef).toBe(true);
	expect(byAction["page.press"]?.needsTargetRef).toBe(false);
	expect(byAction["browser.selectTab"]?.needsTargetRef).toBe(true);
});

test("commands map to the allowlisted tools with `target` refs and report the resulting page", async () => {
	const { adapter, fake } = await opened();
	const commands: AdapterCommand[] = [
		{ action: "browser.navigate", url: "https://example.com/" },
		{ action: "browser.back" },
		CLICK,
		{ action: "page.hover", targetRef: "f1e7", element: "menu" },
		{
			action: "page.fill",
			targetRef: "e5",
			element: "search",
			text: "abc",
			submit: true,
		},
		{
			action: "page.select",
			targetRef: "e6",
			element: "size",
			values: ["L"],
		},
		{ action: "page.press", key: "Enter" },
		{ action: "page.wait", text: "Done", textGone: "Loading", seconds: 2 },
	];
	for (const command of commands)
		expect(await adapter.dispatch(command, NEVER)).toEqual({
			status: "confirmed",
			retryable: false,
			url: "https://a.test/",
			title: "A",
		});
	expect(
		fake
			.calls()
			.slice(1)
			.map((c) => [c.name, c.arguments]),
	).toEqual([
		["browser_navigate", { url: "https://example.com/" }],
		["browser_navigate_back", {}],
		["browser_click", { target: "e4", element: "open" }],
		["browser_hover", { target: "f1e7", element: "menu" }],
		[
			"browser_type",
			{ target: "e5", element: "search", text: "abc", submit: true },
		],
		["browser_select_option", { target: "e6", element: "size", values: ["L"] }],
		["browser_press_key", { key: "Enter" }],
		["browser_wait_for", { text: "Done", textGone: "Loading", time: 2 }],
	]);
});

test("a result without a page section falls back to the tab list, then to no page", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = (name) =>
		name === "browser_tabs"
			? text(
					tabs([
						"- 0: [B](https://b.test/)",
						"- 1: (current) [C](https://c.test/)",
					]),
				)
			: text("### Result\nok");
	expect(await adapter.dispatch(CLICK, NEVER)).toEqual({
		status: "confirmed",
		retryable: false,
		url: "https://c.test/",
		title: "C",
	});
	fake.onTool = (name) =>
		name === "browser_tabs" ? failure("boom") : text("### Result\nok");
	// The click was accepted; only the page is unknown.
	expect(await adapter.dispatch(CLICK, NEVER)).toEqual({
		status: "confirmed",
		retryable: false,
	});
});

test("scroll is unsupported, and capture is not a dispatch command: nothing is sent and no key stands in", async () => {
	const { adapter, fake } = await opened();
	const before = fake.calls().length;
	for (const command of [
		{ action: "page.scroll", direction: "down" },
		{ action: "page.scroll", direction: "up", targetRef: "e1" },
		{ action: "page.capture" },
		{ action: "bogus" },
	] as unknown as AdapterCommand[])
		expect(await adapter.dispatch(command, NEVER)).toEqual({
			status: "not_dispatched",
			code: "unsupported",
			retryable: false,
		});
	expect(fake.calls().length).toBe(before);
});

test("arguments that are not valid are refused before anything is sent", async () => {
	const { adapter, fake } = await opened();
	const before = fake.calls().length;
	const refused = async (command: AdapterCommand) =>
		(await adapter.dispatch(command, NEVER)).code;
	for (const targetRef of ["body > a", "text=Delete", "e4; x", "", "E4", "e"])
		expect(await refused({ ...CLICK, targetRef })).toBe("invalid_ref");
	for (const url of ["javascript:alert(1)", "file:///etc/passwd", "nope"])
		expect(await refused({ action: "browser.navigate", url })).toBe(
			"invalid_url",
		);
	expect(await refused({ action: "page.wait" })).toBe("invalid_wait");
	expect(await refused({ action: "page.wait", seconds: -1 })).toBe(
		"invalid_wait",
	);
	expect(await adapter.dispatch(CLICK, NEVER)).toMatchObject({
		status: "confirmed",
	});
	expect(fake.calls().length).toBe(before + 1);
});

test("platform errors known not to reach the page are failed; ones that may have are indeterminate", async () => {
	const { adapter, fake } = await opened();
	const run = async (
		tool: string,
		message: string,
		command: AdapterCommand = CLICK,
	) => {
		fake.onTool = (name) => (name === tool ? failure(message) : text(PAGE));
		return adapter.dispatch(command, NEVER);
	};
	expect(
		await run(
			"browser_click",
			"Ref e4 not found in the current page snapshot. Try capturing new snapshot.",
		),
	).toEqual({ status: "failed", code: "stale_ref", retryable: false });
	expect(await run("browser_click", CLICK_NEVER_PERFORMED)).toEqual({
		status: "failed",
		code: "action_timeout",
		retryable: true,
	});
	expect(await run("browser_click", CLICK_PERFORMED)).toEqual({
		status: "indeterminate",
		code: "action_timeout",
		retryable: false,
	});
	expect(
		await run("browser_click", "locator.click: Timeout 5000ms exceeded."),
	).toEqual({
		status: "indeterminate",
		code: "action_timeout",
		retryable: false,
	});
	expect(
		await run("browser_navigate", NAME_NOT_RESOLVED, {
			action: "browser.navigate",
			url: "https://x.test/",
		}),
	).toEqual({ status: "failed", code: "navigation_failed", retryable: true });
	expect(
		await run("browser_click", "strict mode violation: resolved to 2 elements"),
	).toEqual({ status: "failed", code: "ref_ambiguous", retryable: false });
	expect(await run("browser_click", "something odd")).toEqual({
		status: "indeterminate",
		code: "mcp_error",
		retryable: false,
	});
	expect(adapter.state()).toBe("open");
});

test("a lost transport after sending is indeterminate and never retryable", async () => {
	const timing = await opened({ callTimeoutMs: 50 });
	timing.fake.onTool = hang;
	expect(await timing.adapter.dispatch(CLICK, NEVER)).toEqual({
		status: "indeterminate",
		code: "call_timeout",
		retryable: false,
	});

	const dying = await opened();
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

	const protocol = await opened();
	protocol.fake.transportError = null;
	protocol.fake.onTool = () => {
		throw new Error("handler bug");
	};
	expect(await protocol.adapter.dispatch(CLICK, NEVER)).toMatchObject({
		status: "indeterminate",
		code: "mcp_unavailable",
	});
});

test("a browser closed under the adapter ends the session as lost", async () => {
	const ctx = await opened();
	ctx.fake.onTool = () =>
		failure("Target page, context or browser has been closed");
	expect(await ctx.adapter.dispatch(CLICK, NEVER)).toEqual({
		status: "indeterminate",
		code: "browser_closed",
		retryable: false,
	});
	await Bun.sleep(10);
	expect(ctx.adapter.state()).toBe("lost");
	expect(ctx.fake.closeCount).toBe(1);
});

test("an abort sends the call as cancelled, and one before the send never reaches the child", async () => {
	const ctx = await opened();
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
	expect(ctx.adapter.state()).toBe("open");
});

test("observe returns the snapshot body untouched with the page it came from", async () => {
	const { adapter, fake, workDir } = await opened();
	// Page text that looks like the response format stays in the body.
	const body = ['- text: "### Page"', "```", "### Error", "x", BODY].join("\n");
	fake.onTool = () => inlineSnapshot(body);
	expect(await adapter.observe(NEVER)).toEqual({
		body,
		url: "https://a.test/",
		title: "A",
		truncated: false,
		missing: [],
	});
	expect(fake.calls().at(-1)).toEqual({
		name: "browser_snapshot",
		arguments: {},
	});
	// A snapshot MCP wrote to its output dir is read, then removed.
	const outputDir = join(workDir, "playwright-mcp-output");
	writeFileSync(join(outputDir, "page-1.yml"), "- link [ref=e9]");
	fake.onTool = () =>
		text(
			`### Page\n- Page URL: https://a.test/\n### Snapshot\n- [Snapshot](.playwright-mcp/page-1.yml)`,
		);
	expect(await adapter.observe(NEVER)).toEqual({
		body: "- link [ref=e9]",
		url: "https://a.test/",
		truncated: false,
		missing: ["title"],
	});
	expect(existsSync(join(outputDir, "page-1.yml"))).toBe(false);
});

test("observe reports a missing page and fails honestly without a body", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = () => text("### Snapshot\n```yaml\n- main [ref=e1]\n```");
	expect(await adapter.observe(NEVER)).toEqual({
		body: "- main [ref=e1]",
		truncated: false,
		missing: ["url", "title"],
	});
	fake.onTool = () => text(PAGE);
	await expect(adapter.observe(NEVER)).rejects.toMatchObject({
		code: "mcp_response_unrecognized",
		dispatched: false,
	});
	fake.onTool = () =>
		text(`${PAGE}\n### Snapshot\n- [Snapshot](.playwright-mcp/gone.yml)`);
	await expect(adapter.observe(NEVER)).rejects.toMatchObject({
		code: "snapshot_file_missing",
	});
	// An error while observing never reached the page, whatever the transport says.
	fake.onTool = hang;
	const controller = new AbortController();
	const pending = adapter.observe(controller.signal);
	await Bun.sleep(10);
	controller.abort();
	await expect(pending).rejects.toMatchObject({
		code: "cancelled",
		dispatched: false,
	});
});

test("targets are listed, selected and opened through browser_tabs with the index as ref", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = (_, args) =>
		text(
			tabs(
				args.action === "new"
					? [
							"- 0: [A](https://a.test/)",
							"- 1: (current) [New](https://example.com/)",
						]
					: ["- 0: (current) [A](https://a.test/)"],
			),
		);
	expect(await adapter.listTargets(NEVER)).toEqual([
		{
			targetRef: "0",
			kind: "tab",
			current: true,
			url: "https://a.test/",
			title: "A",
		},
	]);
	const created = await adapter.newTarget("https://example.com/", NEVER);
	expect(created.map((t) => [t.targetRef, t.current])).toEqual([
		["0", false],
		["1", true],
	]);
	await adapter.selectTarget("0", NEVER);
	expect(
		fake
			.calls()
			.slice(1)
			.map((c) => c.arguments),
	).toEqual([
		{ action: "list" },
		{ action: "new", url: "https://example.com/" },
		{ action: "select", index: 0 },
	]);
	const before = fake.calls().length;
	for (const url of ["file:///etc/passwd", "javascript:1", "nope"])
		await expect(adapter.newTarget(url, NEVER)).rejects.toMatchObject({
			code: "invalid_url",
			dispatched: false,
		});
	for (const ref of ["1.5", "-1", "a", ""])
		await expect(adapter.selectTarget(ref, NEVER)).rejects.toMatchObject({
			code: "invalid_target",
			dispatched: false,
		});
	expect(fake.calls().length).toBe(before);
	fake.onTool = () => text("### Result\nnot a tab list");
	await expect(adapter.listTargets(NEVER)).rejects.toMatchObject({
		code: "mcp_response_unrecognized",
		dispatched: false,
	});
});

test("inspections run fixed read-only functions with no model input in them", async () => {
	const { adapter, fake } = await opened();
	const info = {
		tag: "button",
		type: "submit",
		inForm: true,
		formMethod: "post",
		submits: true,
	};
	fake.onTool = () => text(`### Result\n${JSON.stringify(info, null, 2)}`);
	expect(await adapter.inspect("inspectTarget", "e4", NEVER)).toEqual(info);
	expect(await adapter.inspect("inspectFocused", null, NEVER)).toEqual(info);
	const locator = {
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
	fake.onTool = () => text(`### Result\n${JSON.stringify(locator)}`);
	expect(await adapter.inspect("inspectLocator", "f1e7", NEVER)).toEqual(
		locator,
	);
	const evaluations = fake.calls().filter((c) => c.name === "browser_evaluate");
	expect(evaluations.map((c) => c.arguments)).toEqual([
		{
			function: INSPECT_TARGET_FUNCTION,
			target: "e4",
			element: "inspected element",
		},
		{ function: INSPECT_FOCUSED_FUNCTION },
		{
			function: INSPECT_LOCATOR_FUNCTION,
			target: "f1e7",
			element: "inspected element",
		},
	]);
	for (const source of [
		INSPECT_TARGET_FUNCTION,
		INSPECT_FOCUSED_FUNCTION,
		INSPECT_LOCATOR_FUNCTION,
	])
		expect(source).not.toMatch(/\be4\b|f1e7|http|eumenes/i);
});

test("the locator inspection reads only allowlisted attributes, never text or values", () => {
	for (const forbidden of [
		"textContent",
		"innerText",
		"innerHTML",
		".value",
		"checked",
		"selected",
		"fetch",
		"cookie",
		"localStorage",
	])
		expect(INSPECT_LOCATOR_FUNCTION).not.toContain(forbidden);
	expect(INSPECT_LOCATOR_FUNCTION).toContain("slice(0, 200)");
});

test("inspection results are validated, capped and refs must be snapshot refs", async () => {
	const { adapter, fake } = await opened();
	const before = fake.calls().length;
	for (const ref of ["a > b", "", "E1"])
		await expect(
			adapter.inspect("inspectTarget", ref, NEVER),
		).rejects.toMatchObject({
			code: "invalid_ref",
			dispatched: false,
		});
	await expect(
		adapter.inspect("inspectLocator", null, NEVER),
	).rejects.toMatchObject({
		code: "invalid_ref",
	});
	await expect(
		adapter.inspect("bogus" as never, null, NEVER),
	).rejects.toMatchObject({
		code: "unsupported",
	});
	expect(fake.calls().length).toBe(before);

	fake.onTool = () =>
		text('### Result\n{"tag":"button","inForm":"yes","submits":1}');
	await expect(
		adapter.inspect("inspectFocused", null, NEVER),
	).rejects.toMatchObject({
		code: "inspect_invalid",
		dispatched: false,
	});
	const long = "x".repeat(500);
	fake.onTool = () =>
		text(
			`### Result\n${JSON.stringify({
				tag: "input",
				type: null,
				name: long,
				id: null,
				placeholder: null,
				"aria-label": null,
				"data-testid": null,
				role: null,
				autocomplete: null,
				formId: null,
				formName: null,
				formMethod: null,
				extra: "dropped",
			})}`,
		);
	const facts = await adapter.inspect("inspectLocator", "e1", NEVER);
	expect(facts.name).toBe("x".repeat(200));
	expect(facts).not.toHaveProperty("extra");
	fake.onTool = () => text('### Result\n{"tag":"input"}');
	await expect(
		adapter.inspect("inspectLocator", "e1", NEVER),
	).rejects.toMatchObject({
		code: "inspect_invalid",
	});
	fake.onTool = () => failure("Error: boom");
	await expect(
		adapter.inspect("inspectFocused", null, NEVER),
	).rejects.toMatchObject({
		dispatched: false,
	});
});

test("only allowlisted tools are ever sent, and the unsafe code tool is not on the list", async () => {
	expect(ALLOWED_MCP_TOOLS as readonly string[]).not.toContain(
		"browser_run_code_unsafe",
	);
	for (const name of [
		"browser_run_code_unsafe",
		"browser_file_upload",
		"browser_network_requests",
		"browser_console_messages",
		"browser_drag",
		"browser_fill_form",
		"browser_close",
		"browser_mouse_wheel",
	])
		expect(isAllowedTool(name)).toBe(false);
	expect(ALLOWED_MCP_TOOLS.every(isAllowedTool)).toBe(true);

	const { adapter, fake } = await opened();
	fake.onTool = (_, args) =>
		text(
			args.function
				? '### Result\n{"tag":"a","inForm":false,"submits":false}'
				: tabs(),
		);
	await adapter.listTargets(NEVER);
	await adapter.newTarget("https://example.com/", NEVER);
	await adapter.selectTarget("0", NEVER);
	await adapter.observe(NEVER).catch(() => {});
	for (const command of [
		{ action: "browser.navigate", url: "https://example.com/" },
		{ action: "browser.back" },
		CLICK,
		{ action: "page.hover", targetRef: "e1", element: "x" },
		{
			action: "page.fill",
			targetRef: "e1",
			element: "x",
			text: "t",
			submit: false,
		},
		{ action: "page.select", targetRef: "e1", element: "x", values: ["a"] },
		{ action: "page.press", key: "a" },
		{ action: "page.wait", seconds: 1 },
		{ action: "page.scroll", direction: "down" },
	] satisfies AdapterCommand[])
		await adapter.dispatch(command, NEVER);
	await adapter.inspect("inspectTarget", "e1", NEVER);
	await adapter.inspect("inspectFocused", null, NEVER);
	// The screenshot tool is reached through `capture` alone (the answer here is not an image).
	await adapter.capture("viewport", null, NEVER).catch(() => {});
	const sent = new Set(fake.toolNames());
	for (const name of sent) expect(isAllowedTool(name)).toBe(true);
	expect([...sent].sort()).toEqual([...ALLOWED_MCP_TOOLS].sort());
	expect(Object.keys(adapter).sort()).toEqual(
		[
			"capture",
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
	fake.onTool = async () => {
		await Bun.sleep(5);
		return text(PAGE);
	};
	await Promise.all([
		adapter.dispatch(CLICK, NEVER),
		adapter.dispatch(CLICK, NEVER),
		adapter.observe(NEVER).catch(() => {}),
	]);
	expect(fake.maxActive).toBe(1);
});

test("close stops only its own child, empties the output dir and is idempotent", async () => {
	const { adapter, fake, events, workDir } = await opened();
	const outputDir = join(workDir, "playwright-mcp-output");
	// A file the host keeps in the work dir is not the adapter's to delete.
	writeFileSync(join(workDir, "host-trace.txt"), "keep");
	writeFileSync(join(outputDir, "page-1.yml"), "page text");
	await Promise.all([adapter.close(), adapter.close()]);
	await adapter.close();
	expect(adapter.state()).toBe("closed");
	expect(fake.closeCount).toBe(1);
	expect(existsSync(join(outputDir, "page-1.yml"))).toBe(false);
	expect(readFileSync(join(workDir, "host-trace.txt"), "utf8")).toBe("keep");
	expect(events.filter(([name]) => name === "adapter.closed")).toHaveLength(1);
	expect(await adapter.dispatch(CLICK, NEVER)).toMatchObject({
		status: "not_dispatched",
		code: "not_open",
	});
	// Closing an adapter that never opened starts and stops nothing.
	const idle = setup();
	await idle.adapter.close();
	expect(idle.launches).toHaveLength(0);
	expect(idle.events).toEqual([]);
});

test("a lost session can be closed and opened again with a new child", async () => {
	const ctx = await opened();
	ctx.fake.exit();
	await Bun.sleep(10);
	expect(ctx.adapter.state()).toBe("lost");
	await ctx.adapter.close();
	expect(ctx.adapter.state()).toBe("closed");
	ctx.fake = new FakeSession();
	await ctx.adapter.open(NEVER);
	expect(ctx.adapter.state()).toBe("open");
	expect(ctx.launches).toHaveLength(2);
});

test("logs carry only the fixed event names and fields, never page text or urls", async () => {
	const { adapter, fake, events } = await opened();
	fake.onTool = () => inlineSnapshot("- text: SECRET-PAGE-TEXT");
	await adapter.observe(NEVER);
	await adapter.dispatch(CLICK, NEVER);
	fake.onTool = () =>
		failure(`Ref e4 not found in the current page snapshot. SECRET-ERROR`);
	await adapter.dispatch(CLICK, NEVER);
	await adapter.dispatch(
		{
			action: "browser.navigate",
			url: "https://secret.test/?token=SECRET-URL",
		},
		NEVER,
	);
	await adapter.close();
	expect(events.map(([name]) => name)).toEqual([
		"adapter.opened",
		"adapter.observed",
		"adapter.dispatched",
		"adapter.failed",
		"adapter.failed",
		"adapter.closed",
	]);
	for (const [, fields] of events) {
		expect(
			Object.keys(fields).every((k) =>
				["correlationId", "code", "count", "durationMs"].includes(k),
			),
		).toBe(true);
		expect(fields.correlationId).toBe("corr-1");
	}
	expect(events[3]?.[1].code).toBe("stale_ref");
	expect(JSON.stringify(events)).not.toMatch(/SECRET/);
});

test("a logger that throws cannot break the adapter", async () => {
	const ctx = setup();
	const noisy = createPlaywrightMcpAdapter(
		{
			launch: { command: "/x", args: [] },
			workDir: ctx.workDir,
			logger: {
				event() {
					throw new Error("logger down");
				},
			},
			correlationId: "c",
			browser: { mode: "isolated", headless: true },
		},
		{ startSession: () => ctx.fake },
	);
	await noisy.open(NEVER);
	expect(await noisy.dispatch(CLICK, NEVER)).toMatchObject({
		status: "confirmed",
	});
});

const extracted = (over: Record<string, unknown> = {}) =>
	text(
		`### Result\n${JSON.stringify(
			{
				url: "https://a.test/post",
				title: "Post",
				text: "Para one\n\nPara two",
				charCount: 18,
				root: "article",
				...over,
			},
			null,
			2,
		)}`,
	);

test("extract runs one fixed function; a ref is validated and is the only variable", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = () => extracted();
	expect(await adapter.extract(null, 1000, NEVER)).toEqual({
		url: "https://a.test/post",
		title: "Post",
		text: "Para one\n\nPara two",
		charCount: 18,
		truncated: false,
		root: "article",
	});
	fake.onTool = () => extracted({ root: "target" });
	expect((await adapter.extract("f1e7", 1000, NEVER)).root).toBe("target");
	expect(
		fake
			.calls()
			.filter((c) => c.name === "browser_evaluate")
			.map((c) => c.arguments),
	).toEqual([
		{ function: EXTRACT_PAGE_FUNCTION },
		{
			function: EXTRACT_TARGET_FUNCTION,
			target: "f1e7",
			element: "extracted element",
		},
	]);
	const before = fake.calls().length;
	for (const ref of ["body > a", "", "E1", "e1; x"])
		await expect(adapter.extract(ref, 1000, NEVER)).rejects.toMatchObject({
			code: "invalid_ref",
			dispatched: false,
		});
	expect(fake.calls().length).toBe(before);
});

test("extract caps the text at the smaller of the request and the hard bound", async () => {
	const { adapter, fake } = await opened();
	const long = "x".repeat(100);
	fake.onTool = () => extracted({ text: long, charCount: 100 });
	expect(await adapter.extract(null, 10, NEVER)).toMatchObject({
		text: "x".repeat(10),
		charCount: 100,
		truncated: true,
	});
	expect(await adapter.extract(null, 100, NEVER)).toMatchObject({
		text: long,
		truncated: false,
	});
	// The function itself stops at the hard bound; the caller cannot ask for more.
	const hard = "y".repeat(EXTRACT_HARD_MAX_CHARS);
	fake.onTool = () =>
		extracted({ text: hard, charCount: EXTRACT_HARD_MAX_CHARS + 500 });
	const result = await adapter.extract(null, 10_000_000, NEVER);
	expect(result.text).toHaveLength(EXTRACT_HARD_MAX_CHARS);
	expect(result).toMatchObject({
		charCount: EXTRACT_HARD_MAX_CHARS + 500,
		truncated: true,
	});
	// A cut never leaves half of a surrogate pair.
	fake.onTool = () => extracted({ text: "ab\u{1F600}cd", charCount: 6 });
	expect((await adapter.extract(null, 3, NEVER)).text).toBe("ab");
	// Empty title and url are left out.
	fake.onTool = () => extracted({ url: "", title: "" });
	const bare = await adapter.extract(null, 100, NEVER);
	expect(bare).not.toHaveProperty("url");
	expect(bare).not.toHaveProperty("title");
	const before = fake.calls().length;
	for (const max of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
		await expect(adapter.extract(null, max, NEVER)).rejects.toMatchObject({
			code: "invalid_max_chars",
			dispatched: false,
		});
	expect(fake.calls().length).toBe(before);
});

test("extract rejects responses that are not the expected shape", async () => {
	const { adapter, fake } = await opened();
	const bad: [string, Parameters<typeof extracted>[0] | string][] = [
		["not json", "oops"],
		["an array", "[]"],
		["null", "null"],
		["an unexpected key", { extra: "x" }],
		["a missing text", { text: undefined }],
		["a numeric text", { text: 5 }],
		["a missing charCount", { charCount: undefined }],
		["a charCount below the text", { charCount: 3 }],
		["a fractional charCount", { charCount: 18.5 }],
		["an unknown root", { root: "footer" }],
		["a target root without a ref", { root: "target" }],
		[
			"a text above the hard bound",
			{
				text: "z".repeat(EXTRACT_HARD_MAX_CHARS + 1),
				charCount: EXTRACT_HARD_MAX_CHARS + 1,
			},
		],
		["a long title", { title: "t".repeat(501) }],
		["a long url", { url: `https://a.test/${"u".repeat(9000)}` }],
		["a non-string url", { url: 3 }],
	];
	for (const [label, response] of bad) {
		fake.onTool = () =>
			typeof response === "string"
				? text(`### Result\n${response}`)
				: extracted(response);
		await expect(
			adapter.extract(null, 100, NEVER),
			label,
		).rejects.toMatchObject({
			code: "mcp_response_unrecognized",
			dispatched: false,
		});
	}
	// A target root is required when a ref was named.
	fake.onTool = () => extracted({ root: "main" });
	await expect(adapter.extract("e1", 100, NEVER)).rejects.toMatchObject({
		code: "mcp_response_unrecognized",
	});
	// A platform error never reached the page.
	fake.onTool = () => failure("Error: boom");
	await expect(adapter.extract(null, 100, NEVER)).rejects.toMatchObject({
		dispatched: false,
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
	const before = fake.calls().length;
	const early = new AbortController();
	early.abort();
	await expect(adapter.extract(null, 100, early.signal)).rejects.toMatchObject({
		code: "cancelled",
		dispatched: false,
	});
	expect(fake.calls().length).toBe(before);
	await adapter.close();
	await expect(adapter.extract(null, 100, NEVER)).rejects.toMatchObject({
		code: "not_open",
		dispatched: false,
	});
});

test("extract logs the character count and codes, never the text or url", async () => {
	const { adapter, fake, events } = await opened();
	fake.onTool = () =>
		extracted({
			text: "SECRET-BODY",
			charCount: 11,
			url: "https://secret.test/",
		});
	await adapter.extract(null, 100, NEVER);
	fake.onTool = () => extracted({ root: "nonsense" });
	await adapter.extract(null, 100, NEVER).catch(() => {});
	expect(events.slice(1)).toEqual([
		[
			"adapter.observed",
			{ correlationId: "corr-1", count: 11, durationMs: expect.any(Number) },
		],
		[
			"adapter.failed",
			{
				correlationId: "corr-1",
				code: "mcp_response_unrecognized",
				durationMs: expect.any(Number),
			},
		],
	]);
	expect(JSON.stringify(events)).not.toMatch(/SECRET/);
});
