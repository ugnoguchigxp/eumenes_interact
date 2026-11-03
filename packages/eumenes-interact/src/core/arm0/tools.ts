import { z } from "zod";
import type {
	HostCall,
	InputProvenance,
	InputValueApprovalRequest,
	ParseRecord,
} from "../../contracts/core.ts";
import type { DeclaredEffect } from "../../contracts/operation.ts";
import { argumentHints, refusal, shown } from "./result.ts";
import {
	browserPageClick,
	browserPageHover,
	browserPagePress,
	browserPageSelect,
	browserPageType2,
	browserPageTypeValue2,
	browserPageWait,
	browserTabOpen,
	browserTabTarget,
	emptyInput,
} from "./schemas.ts";
import type { Work } from "./state.ts";
import type { AgentTool, TaskToolResult } from "./task.ts";
import { TOOL_SUMMARIES } from "./texts.ts";
import { fromPage, squash } from "./text.ts";

/**
 * The page operator's tools (Eumenes `browser-task-tools.ts` `PAGE_TOOLS` and the package
 * `browser.page-operator@5`, commit 98b188d2), reduced to what a one-step core can decide: the schema check,
 * the checks against the run's own state (current tab, latest observation, where a typed value comes from) and
 * the `HostCall` the host executes. Not ported (Eumenes-domain features, see PORTING.md): `collect`, `script`,
 * `history`, `connect`, `capture` and `tab_close`.
 */

/** In the order the package lists them, which is the order of TOOLS. */
export const ARM0_TOOL_IDS = [
	"browser.page.tabs",
	"browser.page.tab_select",
	"browser.page.tab_new",
	"browser.page.navigate",
	"browser.page.back",
	"browser.page.observe",
	"browser.page.click",
	"browser.page.hover",
	"browser.page.type",
	"browser.page.select",
	"browser.page.press",
	"browser.page.wait",
] as const;
export type Arm0ToolId = (typeof ARM0_TOOL_IDS)[number];

const isToolId = (id: string): id is Arm0ToolId =>
	(ARM0_TOOL_IDS as readonly string[]).includes(id);

/** The schema the model is shown; `type` without approved input values offers only the request quotation. */
const shownSchema = (id: Arm0ToolId, grants: boolean) =>
	({
		"browser.page.tabs": emptyInput,
		"browser.page.tab_select": browserTabTarget,
		"browser.page.tab_new": browserTabOpen,
		"browser.page.navigate": browserTabOpen,
		"browser.page.back": emptyInput,
		"browser.page.observe": emptyInput,
		"browser.page.click": browserPageClick,
		"browser.page.hover": browserPageHover,
		"browser.page.type": grants ? browserPageTypeValue2 : browserPageType2,
		"browser.page.select": browserPageSelect,
		"browser.page.press": browserPagePress,
		"browser.page.wait": browserPageWait,
	})[id];

/** TOOLS of the system layer for the offered tools. */
export const toolList = (
	ids: readonly Arm0ToolId[],
	grants: boolean,
): AgentTool[] =>
	ids.map((id) => ({
		id,
		description: TOOL_SUMMARIES[id],
		inputSchema: z.toJSONSchema(shownSchema(id, grants)),
	}));

/** The offered tools, in package order; an id the arm does not have is an error. */
export function offeredTools(ids: readonly string[] | undefined) {
	const unknown = ids?.find((id) => !isToolId(id));
	if (unknown !== undefined) throw new Error(`unknown_tool:${unknown}`);
	const offered = ARM0_TOOL_IDS.filter((id) => !ids || ids.includes(id));
	if (!offered.length) throw new Error("no_tools");
	return offered;
}

/** The effect the model declared, as the host's vocabulary. */
const declared = (effect: "navigate" | "input" | "commit"): DeclaredEffect =>
	effect === "navigate"
		? "navigation"
		: effect === "input"
			? "input"
			: "submit";

/** A value much longer than the passage it came from, or a passage too short to mean anything, is not a quotation. */
const QUOTE_MIN = 2;
const QUOTE_VALUE_FACTOR = 4;
const QUOTE_VALUE_SLACK = 32;
const quotes = (value: string, quote: string, request: string) => {
	const q = squash(quote);
	return (
		q.length >= QUOTE_MIN &&
		value.length <= QUOTE_VALUE_FACTOR * q.length + QUOTE_VALUE_SLACK &&
		squash(request).includes(q)
	);
};

type Args = Record<string, any>;

export type Plan =
	/** Execute `call`; `tabRef` is the tab a `tabs.select` moves to. */
	| { kind: "call"; call: HostCall; tabRef?: string }
	/** The call is refused here; the result goes to the model like any tool result. */
	| { kind: "refuse"; result: TaskToolResult; record: ParseRecord }
	/** The run stops and asks the user (a typed value the request does not give). */
	| { kind: "ask"; text: string; approval: InputValueApprovalRequest };

const refuse = (result: TaskToolResult, record: ParseRecord): Plan => ({
	kind: "refuse",
	result,
	record,
});
/** A refusal of the run's own state: the output was well formed, so it is no parse rejection. */
const refuseState = (code: string) => refuse(refusal(code), { accepted: true });

/**
 * Checks one invoked tool the way Eumenes does before anything reaches the page: the tool is offered, the
 * arguments fit its schema, there is a target tab, and the element ref belongs to the tab's latest observation.
 */
export function planCall(
	tool: string,
	args: Record<string, unknown>,
	work: Work,
	request: string,
): Plan {
	if (!isToolId(tool) || !work.tools.includes(tool))
		return refuse(refusal("unknown_tool"), {
			accepted: false,
			rejection: "unknown_tool",
		});
	// `type` is checked against the schema with `inputValueRef` even when it was not offered; the host judges a grant.
	const schema =
		tool === "browser.page.type"
			? browserPageTypeValue2
			: shownSchema(tool, false);
	const parsed = schema.safeParse(args);
	if (!parsed.success) {
		const detail = argumentHints(parsed.error.issues);
		// Diagnose the supplied source branch without changing the authoritative validation above.
		const paired =
			tool === "browser.page.type" && !Object.hasOwn(args, "inputValueRef")
				? browserPageType2.safeParse(args)
				: null;
		const issues =
			paired && !paired.success ? paired.error.issues : parsed.error.issues;
		return refuse(
			refusal("invalid_arguments", {
				...(detail ? { detail } : {}),
				issues: issues.slice(0, 8).map((issue) => ({
					path: issue.path.map(String).join("."),
					code: issue.code,
				})),
			}),
			{ accepted: false, rejection: "schema_violation" },
		);
	}
	// Which fields exist depends on the tool's schema, which has just been checked.
	const a: Args = parsed.data;
	if (tool === "browser.page.tabs")
		return { kind: "call", call: { kind: "tabs.list" } };
	if (tool === "browser.page.tab_select")
		return {
			kind: "call",
			call: { kind: "tabs.select", tabRef: a.tabRef },
			tabRef: a.tabRef,
		};
	if (tool === "browser.page.tab_new")
		return { kind: "call", call: { kind: "tabs.new", url: a.url } };
	if (tool === "browser.page.type" && a.submit && !a.effect)
		return refuseState("effect_required");
	const tabRef = work.tabRef;
	if (!tabRef) return refuseState("no_target_tab");
	if (tool === "browser.page.observe")
		return { kind: "call", call: { kind: "observe", tabRef } };
	const operate = (
		command: Extract<HostCall, { kind: "operate" }>["command"],
		declaredEffect: DeclaredEffect,
		inputProvenance?: InputProvenance,
	): Plan => ({
		kind: "call",
		call: {
			kind: "operate",
			tabRef,
			...("observationRef" in a ? { observationRef: a.observationRef } : {}),
			command,
			declaredEffect,
			...(inputProvenance ? { inputProvenance } : {}),
		},
	});
	switch (tool) {
		case "browser.page.navigate":
			return operate({ action: "browser.navigate", url: a.url }, "navigation");
		case "browser.page.back":
			return operate({ action: "browser.back" }, "navigation");
		case "browser.page.press":
			return operate({ action: "page.press", key: a.key }, declared(a.effect));
		case "browser.page.wait":
			return operate(
				{
					action: "page.wait",
					...(a.text ? { text: a.text } : {}),
					...(a.textGone ? { textGone: a.textGone } : {}),
					...(a.seconds ? { seconds: a.seconds } : {}),
				},
				"none",
			);
	}
	if (tool === "browser.page.type") {
		const origin = work.origin;
		if (!origin) return refuseState("no_page_origin");
		if (a.variable) return refuseState("script_variable_unknown");
		// A value the request does not give is shown to the user before it is typed: a value read from a page is not
		// the user's own, and a quote must be a passage of the request.
		if (
			!a.inputValueRef &&
			(fromPage(a.value, request, work.seen) ||
				!quotes(a.value, a.quote, request))
		)
			return {
				kind: "ask",
				text: `${shown(a.value)}を${origin}の${shown(a.purpose)}に入力してよいですか。依頼の文から確認できない値のため止めました。`,
				approval: {
					kind: "input_value",
					value: a.value,
					origin,
					purpose: a.purpose,
				},
			};
	}
	// The remaining tools act on an element of the tab's latest observation.
	const latest = work.latest[tabRef];
	if (!latest || latest.observationRef !== a.observationRef)
		return refuseState("observation_stale");
	if (!latest.refs.includes(a.ref)) return refuseState("ref_not_actionable");
	switch (tool) {
		case "browser.page.click":
			return operate(
				{ action: "page.click", targetRef: a.ref, element: a.element },
				declared(a.effect),
			);
		case "browser.page.hover":
			return operate(
				{ action: "page.hover", targetRef: a.ref, element: a.element },
				"unknown",
			);
		case "browser.page.select":
			return operate(
				{
					action: "page.select",
					targetRef: a.ref,
					element: a.element,
					values: a.values,
				},
				"input",
			);
		case "browser.page.type":
			return operate(
				{
					action: "page.fill",
					targetRef: a.ref,
					element: a.element,
					// A granted value is resolved by the host from its `inputValueRef`.
					text: a.value ?? "",
					submit: a.submit,
				},
				a.effect ? declared(a.effect) : "input",
				a.inputValueRef
					? { kind: "grant", inputValueRef: a.inputValueRef }
					: { kind: "request_quote", quote: a.quote },
			);
	}
}
