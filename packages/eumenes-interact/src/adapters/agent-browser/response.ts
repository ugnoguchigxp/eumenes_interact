import { textOf, type McpToolResult } from "../mcp/common.ts";

/**
 * Reading of `agent-browser` 0.39.4 MCP tool results. The server returns the CLI's output as one
 * text block (a snapshot is a plain tree without a header). Formats other than the snapshot are not
 * contractually fixed, so each reader accepts the plain text and a JSON rendering of the same fact,
 * and gives up (`undefined` / `null`) rather than guess. Nothing here logs or stores response text.
 */

/** A tab as `tab_list` reports it. `id` is the stable `t<N>` handle. */
export type AbTab = {
	id: string;
	url: string;
	title: string;
	current: boolean;
};

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** A value the server may print bare, quoted or inside `{ <key>: ... }`, as a string. */
export function scalarOf(text: string, key: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return "";
	let value: unknown = trimmed;
	if (/^["{[]/.test(trimmed)) {
		value = parseJson(trimmed);
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			const record = value as Record<string, unknown>;
			const data = record.data;
			value =
				record[key] ??
				(typeof data === "object" && data !== null
					? (data as Record<string, unknown>)[key]
					: undefined);
		}
	}
	return typeof value === "string" ? value : undefined;
}

/** The current page URL, only when it is a single token that looks like one. */
export function parseUrl(raw: McpToolResult): string | undefined {
	const url = scalarOf(textOf(raw), "url");
	return url !== undefined &&
		/^[a-z][a-z0-9+.-]*:\S*$/i.test(url) &&
		url.length <= 8192
		? url
		: undefined;
}

export function parseTitle(raw: McpToolResult): string | undefined {
	const title = scalarOf(textOf(raw), "title");
	return title !== undefined && title.length <= 1000 ? title : undefined;
}

const TAB_ID = /^t\d+$/;

function tabFrom(value: unknown): AbTab | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const tab = value as Record<string, unknown>;
	const id = tab.tabId ?? tab.id;
	if (typeof id !== "string" || !TAB_ID.test(id)) return undefined;
	const active = tab.active ?? tab.current;
	return {
		id,
		url: typeof tab.url === "string" ? tab.url : "",
		title: typeof tab.title === "string" ? tab.title : "",
		current: active === true,
	};
}

/**
 * The tabs of a `tab_list` result: a JSON array, or an object holding one under `tabs` (optionally
 * inside `data`). `null` when the text is not recognised (no line parsing: the format is not documented).
 */
export function parseTabs(raw: McpToolResult): AbTab[] | null {
	const text = textOf(raw).trim();
	let value = parseJson(text);
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const data = record.data;
		value =
			record.tabs ??
			(typeof data === "object" && data !== null
				? (data as Record<string, unknown>).tabs
				: undefined);
	}
	if (!Array.isArray(value)) return null;
	const tabs = value.map(tabFrom);
	return tabs.every((tab) => tab !== undefined) ? (tabs as AbTab[]) : null;
}

/** A fixed script's result: bare, or a JSON string holding JSON (the tool may quote what the script returns). */
export function evalResult(raw: McpToolResult): string | undefined {
	const text = textOf(raw).trim();
	if (text.startsWith('"')) {
		const value = parseJson(text);
		return typeof value === "string" ? value : undefined;
	}
	return text;
}

export type ToolFailure = { code: string; dispatched: boolean };

/** Tools whose failure can change nothing on the page. */
const NO_EFFECT_TOOLS = new Set([
	"agent_browser_snapshot",
	"agent_browser_get_url",
	"agent_browser_get_title",
	"agent_browser_get_text",
	"agent_browser_get_box",
	"agent_browser_wait_ms",
	"agent_browser_wait_for_text",
	"agent_browser_wait_for_load",
	"agent_browser_tab_list",
]);

/** The message of an error result: the text, or the `error`/`message` of a JSON rendering, without an `Error:` prefix. */
function messageOf(text: string): string {
	const json = /^\s*\{/.test(text) ? parseJson(text) : undefined;
	let message = text;
	if (typeof json === "object" && json !== null) {
		const record = json as Record<string, unknown>;
		const found = record.error ?? record.message;
		if (typeof found === "string") message = found;
	}
	return message.trimStart().replace(/^error:\s*/i, "");
}

/**
 * Stable, non-textual classification of an error result, from the error's own first line only. The
 * messages that name an element or a ref carry page-derived text after their fixed beginning, so the
 * patterns are anchored to the start of the line and nothing later in the text is read. `dispatched`
 * is true only when the action may have reached the page: failures documented as happening before
 * the action (a ref that is gone, a covered, hidden, disabled or off-screen target, an ambiguous
 * match, arguments the tool rejected) are not. Anything else may have acted.
 */
export function classifyToolError(text: string, tool?: string): ToolFailure {
	const first = messageOf(text).split("\n", 1)[0] ?? "";
	const noEffect = tool !== undefined && NO_EFFECT_TOOLS.has(tool);
	if (first.startsWith("Stale ref for role="))
		return { code: "stale_ref", dispatched: false };
	if (
		/^(?:Ref not found|Element not found(?: in the selected frame)?:|Unknown ref:|No objectId for ref)/.test(
			first,
		)
	)
		return { code: "stale_ref", dispatched: false };
	if (/^Element '.*' is covered by </.test(first))
		return { code: "target_covered", dispatched: false };
	if (first.startsWith("Element '"))
		return { code: "target_not_actionable", dispatched: false };
	if (first.startsWith("Unknown argument(s) for "))
		return { code: "invalid_params", dispatched: false };
	if (/^Tool \S+ is not enabled by the active MCP tools profile/.test(first))
		return { code: "tool_not_enabled", dispatched: false };
	if (tool === "agent_browser_open" && /net::ERR_[A-Z_]+/.test(first))
		return { code: "navigation_failed", dispatched: false };
	// What `open` reports when the page is still loading at its deadline; the navigation may have committed.
	if (first.startsWith("Operation timed out."))
		return { code: "operation_timeout", dispatched: !noEffect };
	if (first.startsWith("agent-browser command timed out after"))
		return { code: "action_timeout", dispatched: !noEffect };
	return { code: "mcp_error", dispatched: !noEffect };
}
