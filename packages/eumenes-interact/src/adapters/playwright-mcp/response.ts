/**
 * Parsing of `@playwright/mcp` 0.0.83 tool results. The text format belongs to that exact
 * version (pinned by the host); the response tests pin the shapes, so a version bump must
 * pass them. Nothing here logs or stores response text.
 */

import type { McpToolResult } from "../mcp/common.ts";

/** A tab as `browser_tabs` lists it. `index` shifts when tabs close. */
export type McpTab = {
	index: number;
	url: string;
	title: string;
	current: boolean;
};

export type McpSnapshotBody =
	| { kind: "inline"; text: string }
	/** Written by MCP into its output directory; only the file name is kept. */
	| { kind: "file"; name: string };

export type ParsedToolResult = {
	isError: boolean;
	/** `### Error` section text; present on failures. */
	error?: string;
	/** `### Result` section text (tab lists, evaluate output). */
	result?: string;
	/** `title` is absent when the page has none: MCP omits the line then. */
	page?: { url: string; title?: string };
	snapshot?: McpSnapshotBody;
	/** Image content, base64 as MCP sends it. */
	images: { mimeType: string; data: string }[];
};

function parseSections(text: string): Map<string, string> {
	const sections = new Map<string, string>();
	for (const section of text.split(/^### /m).slice(1)) {
		const newline = section.indexOf("\n");
		if (newline === -1) continue;
		sections.set(section.slice(0, newline), section.slice(newline + 1).trim());
	}
	return sections;
}

/**
 * The closing fence of an inline snapshot: a line of three backticks that ends the text or is followed by the
 * next section header. The snapshot is page text, so it may contain such lines itself; the real fence is the
 * last one, because everything MCP writes after the snapshot is made of host sections only.
 */
const FENCE_END = /\n```[ \t]*(?=\n### |\s*$)/g;
const SNAPSHOT_LINK = /\[Snapshot\]\(([^)\n]+)\)/;

/**
 * The snapshot is cut out first: it carries page text, so it must not be split on `### `.
 * Returns the snapshot and the remaining text for section parsing.
 */
function extractSnapshot(text: string): {
	rest: string;
	snapshot?: McpSnapshotBody;
} {
	const header = /^### Snapshot\n/m.exec(text);
	if (!header) return { rest: text };
	const before = text.slice(0, header.index);
	const after = text.slice(header.index + header[0].length);
	if (after.startsWith("```yaml\n")) {
		const body = `\n${after.slice("```yaml\n".length)}`;
		const end = [...body.matchAll(FENCE_END)].at(-1);
		if (!end) return { rest: before };
		return {
			rest: `${before}${body.slice(end.index + end[0].length)}`,
			snapshot: { kind: "inline", text: body.slice(1, end.index) },
		};
	}
	const nextHeader = after.search(/^### /m);
	const section = nextHeader === -1 ? after : after.slice(0, nextHeader);
	const rest = `${before}${nextHeader === -1 ? "" : after.slice(nextHeader)}`;
	const link = SNAPSHOT_LINK.exec(section);
	const name = link?.[1] ? linkFileName(link[1]) : undefined;
	return name ? { rest, snapshot: { kind: "file", name } } : { rest };
}

/** Only the base name is trusted: links are relative to MCP's workspace or absolute. */
export function linkFileName(link: string): string | undefined {
	if (link.includes("\0")) return undefined;
	const name = link.split(/[\\/]/).pop();
	return name && name !== "." && name !== ".." ? name : undefined;
}

function parsePage(section: string | undefined) {
	if (!section) return undefined;
	const url = /^- Page URL: (.*)$/m.exec(section)?.[1];
	if (url === undefined) return undefined;
	const title = /^- Page Title: (.*)$/m.exec(section)?.[1];
	return title === undefined ? { url } : { url, title };
}

export function parseToolResult(raw: McpToolResult): ParsedToolResult {
	const content = raw.content ?? [];
	const first = content[0];
	const text = first?.type === "text" ? first.text : "";
	const { rest, snapshot } = extractSnapshot(text);
	const sections = parseSections(rest);
	return {
		isError: raw.isError === true || sections.has("Error"),
		error: sections.get("Error"),
		result: sections.get("Result"),
		page: parsePage(sections.get("Page")),
		snapshot,
		images: content.flatMap((item) =>
			item.type === "image"
				? [{ mimeType: item.mimeType, data: item.data }]
				: [],
		),
	};
}

const TAB_LINE = /^- (\d+):( \(current\))? \[(.*)\]\((.*)\)(?: \[crashed\])?$/;

/** `- 1: (current) [Title](url)` lines; `null` when the section is not a tab list. */
export function parseTabList(result: string | undefined): McpTab[] | null {
	if (result === undefined) return null;
	if (result.startsWith("No open tabs")) return [];
	const tabs: McpTab[] = [];
	for (const line of result.split("\n")) {
		const match = TAB_LINE.exec(line.trimEnd());
		if (!match) return null;
		tabs.push({
			index: Number(match[1]),
			title: match[3] ?? "",
			url: match[4] ?? "",
			current: match[2] !== undefined,
		});
	}
	return tabs;
}

export type ToolFailure = { code: string; dispatched: boolean };

/** MCP tools whose failure can change nothing on the page. */
const NO_EFFECT_TOOLS = new Set(["browser_hover", "browser_wait_for"]);
/** MCP tools that load a page; a navigation error before any response means the page never changed. */
const NAVIGATION_TOOLS = new Set(["browser_navigate", "browser_navigate_back"]);
/**
 * Playwright's call log says the pointer action itself started (`performing click action`,
 * `click action done`) ...
 */
const ACTION_STARTED = /^\s*-\s+(?:performing \w+ action|\w+ action done)\b/m;
/** ... or that it was still waiting to be allowed to start (whole retry lines of the actionability loop). */
const STILL_GATED =
	/^\s*-\s+(?:element is not (?:visible|enabled|editable|stable|attached)|element is outside of the viewport|.*\bintercepts pointer events|did not find some options|option being selected is not enabled)\s*$/m;
/** The call log must start right after the error's own first line. */
const CALL_LOG = /^[^\n]*\nCall log:\n([\s\S]*)$/;

/**
 * Stable, non-textual classification of a `### Error` body. The text itself is never kept. `dispatched`
 * is true only when the action may have reached the page, which is what makes an operation indeterminate:
 * failures that provably happened before anything was performed (a ref that is not there, a click that never
 * got past Playwright's actionability wait, a name that did not resolve) are not.
 *
 * Deliberate deviation from Eumenes (safety): the call log quotes page text (`locator resolved to
 * <button>…</button>`), so a page could imitate an error phrase. Codes come from the error's own first line
 * only, and the "gated" evidence only from whole call-log lines; evidence that the action started is read
 * first and always wins, so no page text can turn a possibly-performed action into a retryable one.
 */
export function classifyToolError(
	error: string | undefined,
	tool?: string,
): ToolFailure {
	const text = error ?? "";
	const first = text.split("\n", 1)[0] ?? "";
	const log = CALL_LOG.exec(text)?.[1];
	const noEffect = tool !== undefined && NO_EFFECT_TOOLS.has(tool);
	const started = log !== undefined && ACTION_STARTED.test(log);
	/** A failure that provably came before anything was performed, unless the log shows the action started. */
	const unsent = (code: string): ToolFailure => ({
		code,
		dispatched: started && !noEffect,
	});
	if (
		/^(?:Error:\s*)?Ref \S+ not found in the current page snapshot\./.test(
			first,
		)
	)
		return unsent("stale_ref");
	if (
		/browser has been closed|extension disconnected|extension not connected|playwright client disconnected/i.test(
			first,
		)
	)
		return { code: "browser_closed", dispatched: true };
	if (/strict mode violation/i.test(first)) return unsent("ref_ambiguous");
	if (/Element is not a <select> element/i.test(first))
		return unsent("element_not_select");
	const timeout = /Timeout \d+ms exceeded/.test(first);
	if (noEffect)
		return {
			code: timeout ? "action_timeout" : "mcp_error",
			dispatched: false,
		};
	if (tool && NAVIGATION_TOOLS.has(tool)) {
		if (/net::ERR_[A-Z_]+/.test(first)) return unsent("navigation_failed");
		if (/cannot go back|no (?:previous|history)/i.test(first))
			return unsent("navigation_failed");
		if (timeout) return { code: "navigation_timeout", dispatched: true };
	}
	if (timeout) {
		// Without a call log there is nothing to prove the action never ran.
		if (log === undefined || started)
			return { code: "action_timeout", dispatched: true };
		return {
			code: "action_timeout",
			dispatched: !(tool === "browser_click" || STILL_GATED.test(log)),
		};
	}
	return { code: "mcp_error", dispatched: true };
}
