import { AdapterError } from "../../contracts/adapter.ts";
import type { AdapterCommand } from "../../contracts/operation.ts";
import { refOf, webUrl } from "../mcp/common.ts";

/**
 * The closed list of `@playwright/mcp` tools the adapter may call, and the mapping of adapter
 * commands onto them. `browser_evaluate` is reached only through the fixed functions of
 * `mcp/inspect.ts`. `browser_run_code_unsafe` (arbitrary code in the server process) is not on the
 * list (plan.md §5.2). `browser_take_screenshot` is reached only through `capture`.
 */
export const ALLOWED_MCP_TOOLS = [
	"browser_tabs",
	"browser_navigate",
	"browser_navigate_back",
	"browser_snapshot",
	"browser_click",
	"browser_hover",
	"browser_type",
	"browser_select_option",
	"browser_press_key",
	"browser_wait_for",
	"browser_take_screenshot",
	"browser_evaluate",
] as const;
export type McpToolName = (typeof ALLOWED_MCP_TOOLS)[number];
const ALLOWED: ReadonlySet<string> = new Set(ALLOWED_MCP_TOOLS);

export const isAllowedTool = (name: string): name is McpToolName =>
	ALLOWED.has(name);

/** `targetRef` of a tab is its index as a decimal string (unstable: it shifts when tabs close). */
export function tabIndexOf(targetRef: string): number {
	if (!/^\d{1,6}$/.test(targetRef))
		throw new AdapterError("invalid_target", false);
	return Number(targetRef);
}

/**
 * The tool call of a command. `page.scroll` and `page.capture` have no tool in the closed list and
 * are unsupported; no key sequence stands in for them (plan.md §5.1).
 */
export function commandCall(
	command: AdapterCommand,
): [McpToolName, Record<string, unknown>] {
	switch (command.action) {
		case "browser.navigate":
			return ["browser_navigate", { url: webUrl(command.url) }];
		case "browser.back":
			return ["browser_navigate_back", {}];
		case "page.click":
			return [
				"browser_click",
				{ target: refOf(command.targetRef), element: command.element },
			];
		case "page.hover":
			return [
				"browser_hover",
				{ target: refOf(command.targetRef), element: command.element },
			];
		case "page.fill":
			return [
				"browser_type",
				{
					target: refOf(command.targetRef),
					element: command.element,
					text: command.text,
					submit: command.submit,
				},
			];
		case "page.select":
			return [
				"browser_select_option",
				{
					target: refOf(command.targetRef),
					element: command.element,
					values: command.values,
				},
			];
		case "page.press":
			return ["browser_press_key", { key: command.key }];
		case "page.wait": {
			const args: Record<string, unknown> = {};
			if (command.text !== undefined) args.text = command.text;
			if (command.textGone !== undefined) args.textGone = command.textGone;
			if (command.seconds !== undefined) {
				if (!Number.isFinite(command.seconds) || command.seconds < 0)
					throw new AdapterError("invalid_wait", false);
				args.time = command.seconds;
			}
			if (Object.keys(args).length === 0)
				throw new AdapterError("invalid_wait", false);
			return ["browser_wait_for", args];
		}
		default:
			throw new AdapterError("unsupported", false);
	}
}

/**
 * The arguments of a screenshot, always PNG in CSS pixels (consistent across devices, smaller). The
 * output file MCP writes goes to its output dir (no `filename`), which the adapter empties. `item`
 * needs the ref of an observed element and the other ranges must not have one.
 */
export function captureArgs(
	range: "viewport" | "full" | "item",
	targetRef: string | null,
): Record<string, unknown> {
	const base = { type: "png", scale: "css" };
	switch (range) {
		case "viewport":
		case "full":
			if (targetRef !== null) throw new AdapterError("invalid_ref", false);
			return range === "full" ? { ...base, fullPage: true } : base;
		case "item":
			return { ...base, target: refOf(targetRef), element: "captured element" };
		default:
			throw new AdapterError("invalid_range", false);
	}
}
