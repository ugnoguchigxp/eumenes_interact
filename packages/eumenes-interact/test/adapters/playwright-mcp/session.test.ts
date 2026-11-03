import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlaywrightMcpAdapter } from "../../../src/adapters/playwright-mcp/adapter.ts";
import {
	McpTransportError,
	startMcpSession,
	type McpSession,
} from "../../../src/adapters/playwright-mcp/session.ts";
import { NEVER } from "./fakes.ts";

const STUB = join(import.meta.dir, "fixtures", "stub-mcp.mjs");
const roots: string[] = [];
const sessions: McpSession[] = [];

type Entry = Record<string, unknown>;

function stub(mode = "") {
	const root = mkdtempSync(join(tmpdir(), "interact-stub-"));
	roots.push(root);
	const logFile = join(root, "stub.jsonl");
	const env = { STUB_MODE: mode, STUB_LOG: logFile };
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
	return { root, env, log, start: () => log().find((e) => e.kind === "start") };
}

function session(mode = "") {
	const ctx = stub(mode);
	const child = startMcpSession({
		command: process.execPath,
		args: [STUB],
		cwd: ctx.root,
		env: { PATH: process.env.PATH ?? "", ...ctx.env },
	});
	sessions.push(child);
	return { ...ctx, child };
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const call = (child: McpSession, name = "browser_snapshot", timeoutMs = 5000) =>
	child.request("tools/call", { name, arguments: {} }, { timeoutMs });
const pageOf = (result: unknown) =>
	(result as { content: { text: string }[] }).content[0]?.text ?? "";

afterEach(async () => {
	for (const child of sessions.splice(0)) await child.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("answers are matched by id whatever the chunking: one byte at a time, or two in one write", async () => {
	for (const mode of ["split", "batch", "garbage"]) {
		const { child } = session(mode);
		const init = (await child.request(
			"initialize",
			{},
			{ timeoutMs: 5000 },
		)) as {
			serverInfo: { version: string };
		};
		expect(init.serverInfo.version).toBe("stub-1");
		expect(pageOf(await call(child))).toContain("Page URL: https://a.test/");
	}
});

test("a server request is answered so the server never waits on the client", async () => {
	const { child, log } = session("ping");
	await call(child);
	await Bun.sleep(100);
	expect(log().find((e) => e.kind === "reply")).toMatchObject({
		id: 900,
		result: {},
	});
});

test("an unknown method is an rpc error that names its code and counts as sent", async () => {
	const { child } = session();
	const error = await child
		.request("nope", {}, { timeoutMs: 5000 })
		.catch((e) => e);
	expect(error).toBeInstanceOf(McpTransportError);
	expect(error).toMatchObject({
		reason: "rpc_error",
		dispatched: true,
		rpcCode: -32602,
	});
});

test("a child that exits fails the pending call as exited and notifies listeners once", async () => {
	const { child, log } = session("exit");
	let exits = 0;
	child.onExit(() => exits++);
	const error = await call(child).catch((e) => e);
	expect(error).toMatchObject({ reason: "exited", dispatched: true });
	await Bun.sleep(20);
	expect(exits).toBe(1);
	expect(child.exited()).toBe(true);
	expect(log().some((e) => e.kind === "call")).toBe(true);
	// A request after the exit is refused without being sent.
	expect(await call(child).catch((e) => e)).toMatchObject({
		reason: "exited",
		dispatched: false,
	});
});

test("a timeout and an abort end the call; the abort tells the server to cancel", async () => {
	const { child, log } = session("hang");
	expect(await call(child, "browser_click", 100).catch((e) => e)).toMatchObject(
		{
			reason: "timeout",
			dispatched: true,
		},
	);
	const controller = new AbortController();
	const pending = child
		.request(
			"tools/call",
			{ name: "browser_click", arguments: {} },
			{ signal: controller.signal, timeoutMs: 5000 },
		)
		.catch((e) => e);
	await Bun.sleep(50);
	controller.abort();
	expect(await pending).toMatchObject({ reason: "aborted", dispatched: true });
	await Bun.sleep(100);
	expect(log().some((e) => e.kind === "cancelled")).toBe(true);
	const early = new AbortController();
	early.abort();
	expect(
		await child
			.request("tools/call", {}, { signal: early.signal, timeoutMs: 5000 })
			.catch((e) => e),
	).toMatchObject({ reason: "aborted", dispatched: false });
});

test("close ends the child and is safe to repeat", async () => {
	const { child, start } = session();
	await call(child);
	const pid = start()?.pid as number;
	expect(alive(pid)).toBe(true);
	await child.close();
	await child.close();
	expect(alive(pid)).toBe(false);
});

test("the adapter drives a real child process over stdio and stops it on close", async () => {
	const ctx = stub();
	const workDir = join(ctx.root, "work");
	const adapter = createPlaywrightMcpAdapter({
		launch: { command: process.execPath, args: [STUB], env: ctx.env },
		workDir,
		logger: { event() {} },
		correlationId: "c",
		browser: { mode: "isolated", headless: false },
		callTimeoutMs: 5000,
	});
	await adapter.open(NEVER);
	const start = ctx.start() as {
		pid: number;
		argv: string[];
		envKeys: string[];
		cwd: string;
	};
	expect(start.argv).toEqual([
		"--isolated",
		"--output-dir",
		join(workDir, "playwright-mcp-output"),
		"--no-webmcp",
		"--config",
		join(workDir, "playwright-mcp.config.json"),
	]);
	expect(
		start.envKeys.every((k) =>
			["HOME", "PATH", "STUB_LOG", "STUB_MODE"].includes(k),
		),
	).toBe(true);
	expect(adapter.toolInfo()).toEqual({
		name: "@playwright/mcp",
		version: "stub-1",
	});
	const observation = await adapter.observe(NEVER);
	expect(observation).toEqual({
		body: '- button "Go" [ref=e2]',
		url: "https://a.test/",
		title: "A",
		truncated: false,
		missing: [],
	});
	expect(
		await adapter.dispatch({ action: "page.press", key: "Enter" }, NEVER),
	).toMatchObject({ status: "confirmed", url: "https://a.test/" });
	expect(alive(start.pid)).toBe(true);
	await adapter.close();
	expect(adapter.state()).toBe("closed");
	expect(alive(start.pid)).toBe(false);
});

test("a child that exits while the adapter opens fails the open as process_exited", async () => {
	const ctx = stub("exit");
	const adapter = createPlaywrightMcpAdapter({
		launch: { command: process.execPath, args: [STUB], env: ctx.env },
		workDir: join(ctx.root, "work"),
		logger: { event() {} },
		correlationId: "c",
		browser: { mode: "isolated", headless: true },
		connectTimeoutMs: 5000,
		callTimeoutMs: 5000,
	});
	// The stub exits on its first tool call, which is the one `open` makes.
	await expect(adapter.open(NEVER)).rejects.toMatchObject({
		code: "process_exited",
		dispatched: false,
	});
	expect(adapter.state()).toBe("closed");
	await adapter.close();
});
