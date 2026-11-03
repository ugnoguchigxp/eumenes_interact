/**
 * A tiny stand-in for `@playwright/mcp`: newline-delimited JSON-RPC on stdio. It never starts a
 * browser. Behaviour comes from STUB_MODE; start-up facts are written to STUB_LOG (a file path).
 * Modes: "split" (answers in one-byte chunks), "batch" (two answers in one write),
 * "ping" (a server request before each answer), "hang" (never answers tools/call),
 * "exit" (exits on tools/call), "garbage" (non-JSON lines between answers).
 */
import { appendFileSync } from "node:fs";

const mode = process.env.STUB_MODE ?? "";
const logFile = process.env.STUB_LOG;
const log = (entry) => {
	if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
log({
	kind: "start",
	pid: process.pid,
	argv: process.argv.slice(2),
	envKeys: Object.keys(process.env).sort(),
	cwd: process.cwd(),
});

const write = (message) => {
	const line = `${JSON.stringify(message)}\n`;
	if (mode === "split") {
		for (const byte of Buffer.from(line)) process.stdout.write(Buffer.of(byte));
	} else process.stdout.write(line);
};
const text = (value) => ({ content: [{ type: "text", text: value }] });
const PAGE = "### Page\n- Page URL: https://a.test/\n- Page Title: A";
const TABS = "- 0: (current) [A](https://a.test/)";

function tool(name) {
	if (name === "browser_tabs") return text(`### Result\n${TABS}`);
	if (name === "browser_snapshot")
		return text(
			`${PAGE}\n### Snapshot\n\`\`\`yaml\n- button "Go" [ref=e2]\n\`\`\``,
		);
	return text(PAGE);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const message = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (message.method === "initialize") {
			write({
				jsonrpc: "2.0",
				id: message.id,
				result: { serverInfo: { name: "Playwright", version: "stub-1" } },
			});
		} else if (message.method === "tools/call") {
			log({ kind: "call", name: message.params.name });
			if (mode === "exit") process.exit(3);
			if (mode === "hang") continue;
			if (mode === "ping") write({ jsonrpc: "2.0", id: 900, method: "ping" });
			if (mode === "garbage") process.stdout.write("not json\n\n");
			const result = tool(message.params.name);
			const answer = { jsonrpc: "2.0", id: message.id, result };
			if (mode === "batch")
				process.stdout.write(
					`${JSON.stringify(answer)}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" })}\n`,
				);
			else write(answer);
		} else if (message.method === "notifications/cancelled") {
			log({ kind: "cancelled" });
		} else if (message.method === undefined) {
			log({ kind: "reply", id: message.id, result: message.result });
		} else if (message.id === undefined) {
			// notifications need no answer
		} else {
			write({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32602, message: "bad params" },
			});
		}
	}
});
process.stdin.on("end", () => process.exit(0));
