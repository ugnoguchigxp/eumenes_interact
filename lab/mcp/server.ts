import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createInteractMcpServer } from "./interact-server.ts";
import { realDeps } from "./runtime.ts";

/**
 * MCP stdio server for external agents (`bun lab/mcp/server.ts`). stdout carries only the protocol; every
 * diagnostic goes to stderr. A run never outlives the connection: when stdin closes or a signal arrives the
 * active run is cancelled, awaited (bounded) and the process exits.
 */

const mcp = createInteractMcpServer(realDeps());
const transport = new StdioServerTransport();

let stopping = false;
async function stop(code: number) {
	if (stopping) return;
	stopping = true;
	try {
		await mcp.shutdown();
		await transport.close();
	} finally {
		process.exit(code);
	}
}

// The transport only listens for data; the end of the input is ours to notice.
process.stdin.once("end", () => void stop(0));
process.stdin.once("close", () => void stop(0));
process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));
transport.onclose = () => void stop(0);

await mcp.server.connect(transport);
console.error("eumenes-interact MCP server ready (stdio)");
