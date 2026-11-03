import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "../../mcp/server.ts");
const rpc = (id: number, method: string, params: unknown) =>
	`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

const INITIALIZE = rpc(1, "initialize", {
	protocolVersion: "2025-06-18",
	capabilities: {},
	clientInfo: { name: "test", version: "0" },
});

/** The child with its stdout read from the start, so lines can be awaited and the rest collected. */
function spawnServer() {
	const proc = Bun.spawn(["bun", SERVER], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let text = "";
	const waiting: (() => void)[] = [];
	const reading = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of proc.stdout) {
			text += decoder.decode(chunk, { stream: true });
			for (const wake of waiting.splice(0)) wake();
		}
	})();
	const lineCount = () => text.split("\n").filter(Boolean).length;
	return {
		stdin: proc.stdin,
		kill: (signal?: NodeJS.Signals) => proc.kill(signal),
		/** Resolves when `count` lines have arrived (or the child's stdout ended). */
		async lines(count: number) {
			while (lineCount() < count && !proc.killed && proc.exitCode === null)
				await new Promise<void>((resolve) => {
					waiting.push(resolve);
					setTimeout(resolve, 50);
				});
		},
		/** The exit code once the child has ended, and everything it wrote to stdout. */
		async end() {
			const timer = setTimeout(() => proc.kill(), 15_000);
			try {
				const code = await proc.exited;
				await reading;
				return { code, out: text };
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/** Every stdout line must be a JSON-RPC message; anything else on stdout would corrupt the protocol. */
function parseRpcLines(out: string) {
	const lines = out.split("\n").filter(Boolean);
	return lines.map((line) => {
		const message = JSON.parse(line) as { jsonrpc?: string };
		expect(message.jsonrpc).toBe("2.0");
		return message as Record<string, any>;
	});
}

describe("the real server over stdio", () => {
	test("stdin closed at once: nothing on stdout, a clean exit", async () => {
		const server = spawnServer();
		await server.stdin.end();
		expect(await server.end()).toEqual({ code: 0, out: "" });
	});

	test("answers JSON-RPC only on stdout, then exits when stdin closes", async () => {
		const server = spawnServer();
		server.stdin.write(INITIALIZE);
		server.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);
		server.stdin.write(rpc(2, "tools/list", {}));
		server.stdin.write(
			rpc(3, "tools/call", {
				name: "interact_run_definition",
				arguments: { definitionId: "no-such-definition", inputs: {} },
			}),
		);
		server.stdin.write(
			rpc(4, "tools/call", {
				name: "interact_list_definitions",
				arguments: {},
			}),
		);
		await server.stdin.flush();
		await server.lines(4);
		await server.stdin.end();
		const { code, out } = await server.end();
		expect(code).toBe(0);
		const byId = new Map(parseRpcLines(out).map((m) => [m.id, m]));
		expect(byId.get(1)!.result.serverInfo.name).toBe("eumenes-interact");
		expect(byId.get(2)!.result.tools).toHaveLength(5);
		expect(byId.get(3)!.result.isError).toBe(true);
		expect(byId.get(3)!.result.content[0].text).toContain(
			"definition_not_found",
		);
		const listed = JSON.parse(byId.get(4)!.result.content[0].text);
		expect(listed.definitions.map((d: { id: string }) => d.id)).toContain(
			"wikipedia-article",
		);
	});

	test("SIGTERM ends the server cleanly", async () => {
		const server = spawnServer();
		server.stdin.write(INITIALIZE);
		await server.stdin.flush();
		await server.lines(1);
		server.kill("SIGTERM");
		const { code, out } = await server.end();
		parseRpcLines(out);
		expect(code).toBe(143);
	});
});
