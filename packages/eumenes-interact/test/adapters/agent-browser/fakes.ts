import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter } from "../../../src/contracts/adapter.ts";
import type { McpToolResult } from "../../../src/adapters/mcp/common.ts";
import { createAgentBrowserAdapter } from "../../../src/adapters/agent-browser/adapter.ts";
import type { McpSessionLaunch } from "../../../src/adapters/mcp/session.ts";
import {
	FakeSession,
	NEVER,
	text,
	type Event,
	type ToolHandler,
} from "../playwright-mcp/fakes.ts";

export type { ToolHandler };

export { FakeSession, NEVER, text };
export { hang } from "../playwright-mcp/fakes.ts";

/** An error result as Agent Browser reports it: the message alone, as the text. */
export const failure = (message: string): McpToolResult => ({
	content: [{ type: "text", text: message }],
	isError: true,
});

export const CORE_TABS = [
	"agent_browser_tools_profiles",
	"agent_browser_open",
	"agent_browser_read",
	"agent_browser_snapshot",
	"agent_browser_back",
	"agent_browser_click",
	"agent_browser_fill",
	"agent_browser_type",
	"agent_browser_press",
	"agent_browser_select",
	"agent_browser_scroll",
	"agent_browser_wait_ms",
	"agent_browser_wait_for_text",
	"agent_browser_wait_for_load",
	"agent_browser_get_text",
	"agent_browser_get_url",
	"agent_browser_get_title",
	"agent_browser_eval",
	"agent_browser_close",
	"agent_browser_tab_new",
	"agent_browser_tab_list",
	"agent_browser_tab_switch",
	"agent_browser_tab_close",
];

export const TREE = '- button "Go" [ref=e2, url=https://a.test/go]';
export const TABS = [
	{ tabId: "t1", url: "https://a.test/", title: "A", active: true },
	{ tabId: "t2", url: "https://b.test/", title: "B", active: false },
];

/** Answers like the server for the calls the adapter makes; a test overrides `onTool`. */
export const defaultTool: ToolHandler = (name) => {
	switch (name) {
		case "agent_browser_snapshot":
			return text(TREE);
		case "agent_browser_get_url":
			return text("https://a.test/");
		case "agent_browser_get_title":
			return text("A");
		case "agent_browser_tab_list":
			return text(JSON.stringify(TABS));
		default:
			return text("ok");
	}
};

const roots: string[] = [];
export function cleanup() {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
}

export function setup(
	over: {
		headless?: boolean;
		args?: string[];
		env?: Record<string, string>;
		tools?: string[];
		snapshot?: {
			includeUrls?: boolean;
			interactive?: boolean;
			compact?: boolean;
		};
		callTimeoutMs?: number;
		closeWaitMs?: number;
	} = {},
) {
	const workDir = mkdtempSync(join(tmpdir(), "interact-ab-"));
	roots.push(workDir);
	const launches: McpSessionLaunch[] = [];
	const events: Event[] = [];
	const adapter: PlatformAdapter = createAgentBrowserAdapter(
		{
			launch: {
				command: "/fake/node",
				args: over.args ?? [
					"/fake/agent-browser.js",
					"mcp",
					"--tools",
					"core,tabs",
				],
				...(over.env ? { env: over.env } : {}),
			},
			workDir,
			logger: { event: (name, fields) => events.push([name, fields]) },
			correlationId: "corr-1",
			browser: { headless: over.headless ?? true },
			...(over.snapshot ? { snapshot: over.snapshot } : {}),
			...(over.callTimeoutMs !== undefined
				? { callTimeoutMs: over.callTimeoutMs }
				: {}),
		},
		{
			startSession: (launch) => {
				launches.push(launch);
				return ctx.fake;
			},
			closeWaitMs: over.closeWaitMs ?? 20,
			closeTimeoutMs: 200,
		},
	);
	const fake = new FakeSession();
	fake.initializeResult = {
		serverInfo: { name: "agent-browser", version: "0.39.4" },
	};
	// Two pages, like the real paginated list.
	const names = over.tools ?? CORE_TABS;
	fake.toolPages = [
		names.slice(0, Math.ceil(names.length / 2)),
		names.slice(Math.ceil(names.length / 2)),
	];
	fake.onTool = defaultTool;
	const ctx = { adapter, fake, launches, events, workDir };
	return ctx;
}

export async function opened(over: Parameters<typeof setup>[0] = {}) {
	const ctx = setup(over);
	await ctx.adapter.open(NEVER);
	return ctx;
}

export type { McpToolResult };
