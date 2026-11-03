import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBrowserAdapter } from "../../../src/adapters/agent-browser/adapter.ts";
import type { PlatformAdapter } from "../../../src/contracts/adapter.ts";
import { NEVER } from "./fakes.ts";

const STUB = join(import.meta.dir, "fixtures", "stub-agent-browser.mjs");
const roots: string[] = [];
const adapters: PlatformAdapter[] = [];

type Entry = Record<string, unknown>;

function setup(mode = "") {
	const root = mkdtempSync(join(tmpdir(), "interact-ab-stub-"));
	roots.push(root);
	const logFile = join(root, "stub.jsonl");
	const workDir = join(root, "work");
	const adapter = createAgentBrowserAdapter(
		{
			launch: {
				command: process.execPath,
				args: [STUB, "mcp", "--tools", "core,tabs"],
				env: { STUB_MODE: mode, STUB_LOG: logFile },
			},
			workDir,
			logger: { event() {} },
			correlationId: "c",
			browser: { headless: true },
			connectTimeoutMs: 5000,
			callTimeoutMs: 5000,
		},
		{ closeTimeoutMs: 300, closeWaitMs: 50 },
	);
	adapters.push(adapter);
	const log = (): Entry[] => {
		try {
			return readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	};
	return {
		adapter,
		workDir,
		log,
		start: () =>
			log().find((e) => e.kind === "start") as Entry & { pid: number },
		calls: () =>
			log()
				.filter((e) => e.kind === "call")
				.map((e) => e.name),
	};
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

afterEach(async () => {
	for (const adapter of adapters.splice(0)) await adapter.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("the adapter drives a child over stdio: paginated tool list, own environment, close ends the child", async () => {
	const ctx = setup();
	await ctx.adapter.open(NEVER);
	expect(ctx.adapter.state()).toBe("open");
	expect(ctx.adapter.toolInfo()).toEqual({
		name: "agent-browser",
		version: "stub-0.39",
	});
	const start = ctx.start();
	expect(start.argv).toEqual(["mcp", "--tools", "core,tabs"]);
	const env = start.env as Record<string, string>;
	expect(env.AGENT_BROWSER_SESSION).toMatch(/^ei-[0-9a-f]{16}$/);
	expect(env.AGENT_BROWSER_ARGS).toBe("--mute-audio");
	expect(readFileSync(env.AGENT_BROWSER_CONFIG ?? "", "utf8")).toBe("{}");
	expect(start.cwd).toContain("agent-browser");
	// Nothing has been sent to the browser yet.
	expect(ctx.calls()).toEqual([]);
	const observation = await ctx.adapter.observe(NEVER);
	expect(observation).toEqual({
		body: '- button "Go" [ref=e2]',
		url: "https://a.test/",
		title: "A",
		truncated: false,
		missing: [],
	});
	expect(ctx.calls()).toEqual([
		"agent_browser_open",
		"agent_browser_snapshot",
		"agent_browser_get_url",
		"agent_browser_get_title",
	]);
	expect(alive(start.pid)).toBe(true);
	await ctx.adapter.close();
	expect(ctx.calls().at(-1)).toBe("agent_browser_close");
	expect(alive(start.pid)).toBe(false);
	expect(ctx.adapter.state()).toBe("closed");
});

test("a close that fails or hangs still stops the child", async () => {
	for (const mode of ["close-error", "close-hang"]) {
		const ctx = setup(mode);
		await ctx.adapter.open(NEVER);
		await ctx.adapter.observe(NEVER);
		const pid = ctx.start().pid;
		await ctx.adapter.close();
		expect(ctx.calls()).toContain("agent_browser_close");
		expect(alive(pid), mode).toBe(false);
	}
});

test("a child that exits on the first call leaves the adapter lost; the navigation was never sent", async () => {
	const ctx = setup("exit");
	await ctx.adapter.open(NEVER);
	const result = await ctx.adapter.dispatch(
		{ action: "browser.navigate", url: "https://a.test/" },
		NEVER,
	);
	// The first call is the launch, which carries no command.
	expect(result).toMatchObject({
		status: "not_dispatched",
		code: "process_exited",
		retryable: false,
	});
	expect(ctx.adapter.state()).toBe("lost");
	expect(existsSync(join(ctx.workDir, "agent-browser.config.json"))).toBe(true);
});
