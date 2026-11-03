import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter } from "../../../src/contracts/adapter.ts";
import type {
	InteractEventName,
	InteractLogFields,
} from "../../../src/contracts/common.ts";
import { createPlaywrightMcpAdapter } from "../../../src/adapters/playwright-mcp/adapter.ts";
import type { McpToolResult } from "../../../src/adapters/playwright-mcp/response.ts";
import {
	McpTransportError,
	type McpRequestOptions,
	type McpSession,
	type McpSessionLaunch,
} from "../../../src/adapters/playwright-mcp/session.ts";

export const NEVER = new AbortController().signal;

export const text = (value: string, extra: object = {}): McpToolResult => ({
	content: [{ type: "text", text: value }],
	...extra,
});
export const failure = (message: string): McpToolResult =>
	text(`### Error\n${message}`, { isError: true });

export const PAGE = "### Page\n- Page URL: https://a.test/\n- Page Title: A";
export const BODY = '- main [ref=e1]:\n  - button "Go" [ref=e2]';
export const inlineSnapshot = (body = BODY, page = PAGE) =>
	text(`${page}\n### Snapshot\n\`\`\`yaml\n${body}\n\`\`\`\n### Events\n- x`);
export const tabs = (lines = ["- 0: (current) [A](https://a.test/)"]) =>
	`### Result\n${lines.join("\n")}`;

export type ToolHandler = (
	name: string,
	args: Record<string, unknown>,
) => McpToolResult | Promise<McpToolResult>;

/** Answers like the server for the calls the adapter makes; a test overrides `onTool`. */
export const defaultTool: ToolHandler = (name) => {
	if (name === "browser_tabs") return text(tabs());
	if (name === "browser_snapshot") return inlineSnapshot();
	return text(PAGE);
};

/** A scripted stand-in for the MCP stdio session. Every request is recorded. */
export class FakeSession implements McpSession {
	requests: { method: string; params: unknown }[] = [];
	notified: string[] = [];
	closeCount = 0;
	onTool: ToolHandler = defaultTool;
	initializeResult: unknown = {
		serverInfo: { name: "Playwright", version: "0.0.83" },
	};
	/** Set to make `request` answer with a rejected transport error. */
	transportError: McpTransportError | null = null;
	private hasExited = false;
	private listeners: (() => void)[] = [];
	private pending = new Set<(error: McpTransportError) => void>();
	active = 0;
	maxActive = 0;

	calls() {
		return this.requests
			.filter((r) => r.method === "tools/call")
			.map(
				(r) => r.params as { name: string; arguments: Record<string, unknown> },
			);
	}
	toolNames() {
		return this.calls().map((c) => c.name);
	}
	/** The child dies on its own. */
	exit() {
		if (this.hasExited) return;
		this.hasExited = true;
		for (const reject of this.pending)
			reject(new McpTransportError("exited", true));
		for (const listener of this.listeners) listener();
	}
	async request(method: string, params: unknown, options: McpRequestOptions) {
		this.requests.push({ method, params });
		if (this.hasExited) throw new McpTransportError("exited", false);
		if (this.transportError) throw this.transportError;
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			if (method === "initialize") return this.initializeResult;
			const call = params as {
				name: string;
				arguments: Record<string, unknown>;
			};
			const answer = Promise.resolve().then(() =>
				this.onTool(call.name, call.arguments),
			);
			const interrupted = new Promise<never>((_, reject) => {
				this.pending.add(reject);
				options.signal?.addEventListener("abort", () =>
					reject(new McpTransportError("aborted", true)),
				);
				setTimeout(
					() => reject(new McpTransportError("timeout", true)),
					options.timeoutMs,
				);
			});
			return await Promise.race([answer, interrupted]);
		} finally {
			this.active--;
		}
	}
	notify(method: string) {
		this.notified.push(method);
	}
	onExit(listener: () => void) {
		if (this.hasExited) listener();
		else this.listeners.push(listener);
	}
	exited() {
		return this.hasExited;
	}
	async close() {
		this.closeCount++;
		this.exit();
	}
}

/** A call that is never answered (until the signal or the timeout ends it). */
export const hang = (): Promise<McpToolResult> => new Promise(() => {});

const roots: string[] = [];
export function cleanup() {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
}

export type Event = [InteractEventName, InteractLogFields];

export function setup(
	over: {
		headless?: boolean;
		args?: string[];
		env?: Record<string, string>;
		connectTimeoutMs?: number;
		callTimeoutMs?: number;
	} = {},
) {
	const workDir = mkdtempSync(join(tmpdir(), "interact-pw-"));
	roots.push(workDir);
	const launches: McpSessionLaunch[] = [];
	const events: Event[] = [];
	const adapter: PlatformAdapter = createPlaywrightMcpAdapter(
		{
			launch: {
				command: "/fake/node",
				args: over.args ?? ["/fake/cli.js"],
				...(over.env ? { env: over.env } : {}),
			},
			workDir,
			logger: { event: (name, fields) => events.push([name, fields]) },
			correlationId: "corr-1",
			browser: { mode: "isolated", headless: over.headless ?? true },
			...(over.connectTimeoutMs !== undefined
				? { connectTimeoutMs: over.connectTimeoutMs }
				: {}),
			...(over.callTimeoutMs !== undefined
				? { callTimeoutMs: over.callTimeoutMs }
				: {}),
		},
		{
			startSession: (launch) => {
				launches.push(launch);
				return ctx.fake;
			},
		},
	);
	const ctx = { adapter, fake: new FakeSession(), launches, events, workDir };
	return ctx;
}

export async function opened(over: Parameters<typeof setup>[0] = {}) {
	const ctx = setup(over);
	await ctx.adapter.open(NEVER);
	return ctx;
}
