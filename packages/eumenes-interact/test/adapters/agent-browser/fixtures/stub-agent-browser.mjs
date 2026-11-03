/**
 * A tiny stand-in for `agent-browser mcp`: newline-delimited JSON-RPC on stdio, a paginated
 * `tools/list`, and canned tool answers. It never starts a browser. Behaviour comes from STUB_MODE,
 * start-up facts and calls are appended to STUB_LOG (a file path).
 * Modes: "close-error" (agent_browser_close answers with an error), "close-hang" (never answers it),
 * "exit" (exits on the first tool call).
 */
import { appendFileSync } from "node:fs";

const mode = process.env.STUB_MODE ?? "";
const log = (entry) =>
	process.env.STUB_LOG &&
	appendFileSync(process.env.STUB_LOG, `${JSON.stringify(entry)}\n`);
log({
	kind: "start",
	pid: process.pid,
	argv: process.argv.slice(2),
	cwd: process.cwd(),
	env: Object.fromEntries(
		Object.entries(process.env).filter(([key]) =>
			key.startsWith("AGENT_BROWSER_"),
		),
	),
});

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value, isError = false) => ({
	content: [{ type: "text", text: value }],
	...(isError ? { isError } : {}),
});
const PAGES = [
	["agent_browser_open", "agent_browser_snapshot", "agent_browser_get_url"],
	["agent_browser_get_title", "agent_browser_close"],
];

function tool(name) {
	if (name === "agent_browser_snapshot") return text('- button "Go" [ref=e2]');
	if (name === "agent_browser_get_url") return text("https://a.test/");
	if (name === "agent_browser_get_title") return text("A");
	if (name === "agent_browser_close" && mode === "close-error")
		return text("close failed", true);
	return text("ok");
}

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const message = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (message.method === "initialize")
			write({
				jsonrpc: "2.0",
				id: message.id,
				result: { serverInfo: { name: "agent-browser", version: "stub-0.39" } },
			});
		else if (message.method === "tools/list") {
			const index = message.params?.cursor ? Number(message.params.cursor) : 0;
			write({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					tools: PAGES[index].map((name) => ({ name })),
					...(index + 1 < PAGES.length
						? { nextCursor: String(index + 1) }
						: {}),
				},
			});
		} else if (message.method === "tools/call") {
			const name = message.params.name;
			log({ kind: "call", name, args: message.params.arguments });
			if (mode === "exit") process.exit(3);
			if (name === "agent_browser_close" && mode === "close-hang") continue;
			write({ jsonrpc: "2.0", id: message.id, result: tool(name) });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
