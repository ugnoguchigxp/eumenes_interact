import { AdapterError } from "../../contracts/adapter.ts";
import type { AdapterCommand } from "../../contracts/operation.ts";
import { refOf, webUrl } from "../mcp/common.ts";

/**
 * The closed list of Agent Browser MCP tools the adapter may call (all of the `core` and `tabs`
 * profiles, plus `agent_browser_get_box`, which only a wider profile such as `all` has).
 * `agent_browser_eval` is reachable only through the fixed scripts of `adapter.ts` and `locate.ts`.
 */
export const ALLOWED_AGENT_BROWSER_TOOLS = [
	"agent_browser_open",
	"agent_browser_snapshot",
	"agent_browser_back",
	"agent_browser_click",
	"agent_browser_fill",
	"agent_browser_press",
	"agent_browser_select",
	"agent_browser_scroll",
	"agent_browser_wait_ms",
	"agent_browser_wait_for_text",
	"agent_browser_wait_for_load",
	"agent_browser_get_url",
	"agent_browser_get_title",
	"agent_browser_get_text",
	"agent_browser_get_box",
	"agent_browser_eval",
	"agent_browser_close",
	"agent_browser_tab_new",
	"agent_browser_tab_list",
	"agent_browser_tab_switch",
] as const;
export type AbToolName = (typeof ALLOWED_AGENT_BROWSER_TOOLS)[number];
const ALLOWED: ReadonlySet<string> = new Set(ALLOWED_AGENT_BROWSER_TOOLS);

export const isAllowedTool = (name: string): name is AbToolName =>
	ALLOWED.has(name);

/** What `--tools core,tabs` offers, assumed until the server's own list is read. */
export const CORE_TABS_TOOLS: ReadonlySet<string> = new Set(
	ALLOWED_AGENT_BROWSER_TOOLS.filter(
		(name) => name !== "agent_browser_get_box",
	),
);

/** A ref as the selector argument: `@e5`. */
export const selectorOf = (ref: string | null | undefined) => `@${refOf(ref)}`;

/** `targetRef` of a tab is its stable `t<N>` id (never reused within a session). */
export function tabIdOf(targetRef: string): string {
	if (!/^t\d{1,6}$/.test(targetRef))
		throw new AdapterError("invalid_target", false);
	return targetRef;
}

/** A page load can take far longer than a click: `open` gets its own per-call timeout. */
export const OPEN_TIMEOUT_MS = 45_000;

export type AbCall = { tool: AbToolName; args: Record<string, unknown> };

/**
 * The tool calls of a command, in order. `page.hover` has no tool in `core`/`tabs`, `page.capture`
 * is not in scope and `textGone` would need a script with the model's text in it: all unsupported,
 * and no substitute is sent (plan.md §5.1). `wait` with both seconds and text waits for the time first.
 */
export function commandCalls(
	command: AdapterCommand,
	has: (tool: AbToolName) => boolean,
): AbCall[] {
	const calls = plan(command);
	if (!calls.every((call) => has(call.tool)))
		throw new AdapterError("unsupported", false);
	return calls;
}

function plan(command: AdapterCommand): AbCall[] {
	switch (command.action) {
		case "browser.navigate":
			return [
				{
					tool: "agent_browser_open",
					args: { url: webUrl(command.url), timeoutMs: OPEN_TIMEOUT_MS },
				},
			];
		case "browser.back":
			return [{ tool: "agent_browser_back", args: {} }];
		case "page.click":
			return [
				{
					tool: "agent_browser_click",
					args: { selector: selectorOf(command.targetRef) },
				},
			];
		case "page.fill":
			return [
				{
					tool: "agent_browser_fill",
					args: { selector: selectorOf(command.targetRef), text: command.text },
				},
				...(command.submit
					? [{ tool: "agent_browser_press" as const, args: { key: "Enter" } }]
					: []),
			];
		case "page.select":
			return [
				{
					tool: "agent_browser_select",
					args: {
						selector: selectorOf(command.targetRef),
						values: command.values,
					},
				},
			];
		case "page.press":
			return [{ tool: "agent_browser_press", args: { key: command.key } }];
		case "page.scroll":
			if (command.direction !== "up" && command.direction !== "down")
				throw new AdapterError("unsupported", false);
			return [
				{
					tool: "agent_browser_scroll",
					args: {
						direction: command.direction,
						...(command.targetRef !== undefined
							? { selector: selectorOf(command.targetRef) }
							: {}),
					},
				},
			];
		case "page.wait": {
			if (command.textGone !== undefined)
				throw new AdapterError("unsupported", false);
			const calls: AbCall[] = [];
			if (command.seconds !== undefined) {
				if (!Number.isFinite(command.seconds) || command.seconds < 0)
					throw new AdapterError("invalid_wait", false);
				calls.push({
					tool: "agent_browser_wait_ms",
					args: { ms: Math.max(1, Math.round(command.seconds * 1000)) },
				});
			}
			if (command.text !== undefined)
				calls.push({
					tool: "agent_browser_wait_for_text",
					args: { text: command.text },
				});
			if (calls.length === 0) throw new AdapterError("invalid_wait", false);
			return calls;
		}
		default:
			throw new AdapterError("unsupported", false);
	}
}
