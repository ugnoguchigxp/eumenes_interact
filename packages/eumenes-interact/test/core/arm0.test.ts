import { describe, expect, test } from "bun:test";
import type {
	CoreState,
	HostOutcome,
	ParsedStep,
	StartRunInput,
} from "../../src/contracts/core.ts";
import type { ObservationEnvelope } from "../../src/contracts/observation.ts";
import {
	ARM0_TOOL_IDS,
	applyResult,
	coreApi,
	parseCoreState,
	parseStep,
	prepareStep,
	shapeObservation,
	startRun,
} from "../../src/core/index.ts";

const TAB = "11111111-1111-4111-8111-111111111111";
const TAB2 = "22222222-2222-4222-8222-222222222222";
const ref = (n: number) => `aaaaaaa${n}-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`;
const BODY = [
	"- generic [ref=e1]:",
	'  - combobox "検索" [ref=e2]',
	'  - button "検索する" [ref=e3]',
].join("\n");

const envelope = (
	n: number,
	tabRef = TAB,
	body = BODY,
): ObservationEnvelope => ({
	observationRef: ref(n),
	platform: "playwright-mcp",
	sessionId: "s",
	target: { kind: "tab", tabRef },
	generation: n,
	capturedAt: "2026-11-03T05:00:00.000Z",
	url: "https://shop.example.com/search?q=secret",
	title: "Shop",
	body,
	truncated: false,
	truncationReasons: [],
	refCount: 2,
	missing: [],
});

const start = (patch: Partial<StartRunInput> = {}, observation = true) =>
	startRun({
		arm: "arm0",
		request: "電気ケトルを検索して",
		policy: { maxModelCalls: 6, retries: { default: 1 } },
		nowMs: 1793600000000,
		reference: {
			tabs: [
				{
					tabRef: TAB,
					title: "Shop",
					url: "https://shop.example.com/",
					current: true,
				},
			],
			...(observation ? { observation: envelope(1) } : {}),
		},
		...patch,
	});

const invoke = (tool: string, args: Record<string, unknown> = {}) =>
	JSON.stringify({ action: "invoke", tool, arguments: args });
const click = (n: number, element = "検索する button", extra = {}) =>
	invoke("browser.page.click", {
		observationRef: ref(n),
		ref: "e3",
		element,
		effect: "navigate",
		...extra,
	});
const confirmed = (observation?: ObservationEnvelope): HostOutcome => ({
	kind: "operation",
	result: { operationId: "op", status: "confirmed", retryable: false },
	...(observation ? { observation } : {}),
});

const parse = (state: CoreState, raw: string) => parseStep(state, raw);
const callOf = (step: ParsedStep) => {
	if (step.kind !== "call")
		throw new Error(`expected a call, got ${step.kind}`);
	return step;
};
const lastResult = (state: CoreState) => {
	const { messages } = (
		state as unknown as { task: { messages: { content: string }[] } }
	).task;
	return JSON.parse(messages.at(-1)!.content.replace("TOOL_RESULT=", ""));
};

describe("startRun", () => {
	test("the state is plain JSON of the right version and arm", () => {
		const state = start();
		expect(JSON.parse(JSON.stringify(state))).toEqual(state);
		expect(state).toMatchObject({ formatVersion: 1, arm: "arm0" });
		expect(parseCoreState(state)).toEqual(state);
	});

	test("the REFERENCE shows the views of the tabs and the first observation, never the url's query", () => {
		const { messages, callsLeft } = prepareStep(start());
		expect(callsLeft).toBe(6);
		expect(messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
		expect(messages[2]?.content).toBe("電気ケトルを検索して");
		const reference = JSON.parse(
			messages[1]!.content.split("\nREFERENCE=")[1]!,
		);
		expect(reference.target).toEqual({
			tabRef: TAB,
			title: "Shop",
			place: "https://shop.example.com/search",
		});
		expect(reference.observation).toMatchObject({
			observationRef: ref(1),
			text: BODY,
			refCount: 2,
		});
		expect(reference).toMatchObject({
			scriptRequired: false,
			callsLeft: 6,
			timeZone: "Asia/Tokyo",
		});
		expect(messages[1]?.content).not.toContain("secret");
	});

	test("unknown arm, unknown tools and out-of-bound policies are errors", () => {
		expect(() => start({ arm: "arm1" as "arm0" })).toThrow("unknown_arm");
		expect(() => start({ tools: ["browser.page.script"] })).toThrow(
			"unknown_tool",
		);
		expect(() => start({ tools: [] })).toThrow("no_tools");
		expect(() =>
			start({ policy: { maxModelCalls: 13, retries: { default: 1 } } }),
		).toThrow("core_state_invalid");
	});

	test("tools are offered in the package's order whatever order the host lists", () => {
		const system = prepareStep(
			start({ tools: ["browser.page.wait", "browser.page.tabs"] }),
		).messages[0]!.content;
		const offered = [...system.matchAll(/"id":"(browser\.page\.\w+)"/g)].map(
			(m) => m[1],
		);
		expect(offered).toEqual(["browser.page.tabs", "browser.page.wait"]);
		expect(ARM0_TOOL_IDS).toHaveLength(12);
	});
});

describe("parseStep: output decisions", () => {
	test("a valid observe call becomes a host call and a ParseRecord says accepted", () => {
		const { step, record } = parse(start(), invoke("browser.page.observe"));
		expect(record).toEqual({ accepted: true });
		expect(step).toEqual({
			kind: "call",
			tool: "browser.page.observe",
			call: { kind: "observe", tabRef: TAB },
			callsLeft: 5,
		});
	});

	test("an invalid output is repaired once, then ends the run", () => {
		const first = parseStep(start(), "not json");
		expect(first.step).toEqual({ kind: "continue", callsLeft: 5 });
		expect(first.record).toEqual({
			accepted: false,
			rejection: "unparsable_json",
		});
		expect(prepareStep(first.state).messages.at(-1)?.content).toContain(
			"REJECTED_OUTPUT=",
		);
		const second = parseStep(first.state, "{}");
		expect(second.step).toEqual({ kind: "failed", code: "invalid_contract" });
		expect(second.record).toEqual({
			accepted: false,
			rejection: "schema_violation",
		});
	});

	test("a valid action resets the repair, so the next bad output is repaired again", () => {
		let state = parse(start(), "x").state;
		state = parse(state, invoke("browser.page.observe")).state;
		state = applyResult(state, {
			kind: "observation",
			observation: envelope(2),
		}).state;
		expect(parse(state, "x").step.kind).toBe("continue");
	});

	test("rejection codes tell the break apart", () => {
		const code = (raw: string) => parseStep(start(), raw).record.rejection;
		expect(code("{")).toBe("unparsable_json");
		expect(code('{"action":"dance"}')).toBe("schema_violation");
		expect(
			code('{"action":"finish","text":"x","tool":"browser.page.tabs"}'),
		).toBe("action_fields");
		expect(code('{"action":"invoke"}')).toBe("action_fields");
	});

	test("the last call is reserved for finish or clarify", () => {
		let state = start({
			policy: { maxModelCalls: 2, retries: { default: 1 } },
		});
		state = parseStep(state, invoke("browser.page.observe")).state;
		state = applyResult(state, {
			kind: "observation",
			observation: envelope(2),
		}).state;
		expect(prepareStep(state).callsLeft).toBe(1);
		const last = parseStep(state, invoke("browser.page.observe"));
		expect(last.step).toEqual({ kind: "failed", code: "invoke_on_last_call" });
		expect(last.record).toEqual({
			accepted: false,
			rejection: "invoke_on_last_call",
		});
		const finish = parseStep(
			state,
			JSON.stringify({ action: "finish", text: "完了" }),
		);
		expect(finish.step).toEqual({ kind: "finish", text: "完了", refs: [] });
	});

	test("an invalid last call cannot be repaired", () => {
		const state = start({
			policy: { maxModelCalls: 1, retries: { default: 1 } },
		});
		expect(parseStep(state, "x").step).toEqual({
			kind: "failed",
			code: "turn_limit",
		});
	});

	test("finish keeps only the refs of observations the run saw", () => {
		const raw = JSON.stringify({
			action: "finish",
			text: "確認しました",
			refs: [ref(1), "invented"],
		});
		expect(parseStep(start(), raw).step).toEqual({
			kind: "finish",
			text: "確認しました",
			refs: [ref(1)],
		});
	});

	test("a call cannot be parsed while the previous call has no result", () => {
		const { state } = parseStep(start(), invoke("browser.page.observe"));
		expect(() => parseStep(state, invoke("browser.page.observe"))).toThrow(
			"task_state_invalid",
		);
	});
});

describe("parseStep: tool arguments and the latest observation", () => {
	test("click maps to page.click with the observation and the declared effect", () => {
		const { step } = parse(start(), click(1));
		expect(callOf(step).call).toEqual({
			kind: "operate",
			tabRef: TAB,
			observationRef: ref(1),
			command: {
				action: "page.click",
				targetRef: "e3",
				element: "検索する button",
			},
			declaredEffect: "navigation",
		});
	});

	test("type maps to page.fill with the request quotation as provenance", () => {
		const raw = invoke("browser.page.type", {
			observationRef: ref(1),
			ref: "e2",
			element: "検索 combobox",
			value: "電気ケトル",
			quote: "電気ケトル",
			purpose: "検索語",
			submit: false,
		});
		expect(callOf(parse(start(), raw).step).call).toEqual({
			kind: "operate",
			tabRef: TAB,
			observationRef: ref(1),
			command: {
				action: "page.fill",
				targetRef: "e2",
				element: "検索 combobox",
				text: "電気ケトル",
				submit: false,
			},
			declaredEffect: "input",
			inputProvenance: { kind: "request_quote", quote: "電気ケトル" },
		});
	});

	test("type with an approved input value carries the grant, not the text", () => {
		const state = start({
			reference: {
				observation: envelope(1),
				approved: [{ kind: "input_value", inputValueRef: ref(7) }],
			},
		});
		const raw = invoke("browser.page.type", {
			observationRef: ref(1),
			ref: "e2",
			element: "検索 combobox",
			inputValueRef: ref(7),
			purpose: "検索語",
			submit: true,
			effect: "navigate",
		});
		const call = callOf(parse(state, raw).step).call;
		expect(call).toMatchObject({
			inputProvenance: { kind: "grant", inputValueRef: ref(7) },
			declaredEffect: "navigation",
			command: { action: "page.fill", text: "", submit: true },
		});
	});

	test("a value the request does not give stops the run for the user", () => {
		const raw = invoke("browser.page.type", {
			observationRef: ref(1),
			ref: "e2",
			element: "検索 combobox",
			value: "春の新作",
			quote: "新作を探して",
			purpose: "検索語",
			submit: false,
		});
		const { step, record } = parse(start(), raw);
		expect(step).toEqual({
			kind: "stop",
			code: "input_value_unconfirmed",
			approvals: [
				{
					kind: "input_value",
					value: "春の新作",
					origin: "https://shop.example.com",
					purpose: "検索語",
				},
			],
			text: "「春の新作」をhttps://shop.example.comの「検索語」に入力してよいですか。依頼の文から確認できない値のため止めました。",
		});
		expect(record).toEqual({ accepted: true });
	});

	test("a stale observationRef or an unknown element ref is refused locally, counted against the tool's retries", () => {
		const state = start({
			policy: { maxModelCalls: 6, retries: { default: 2 } },
		});
		let out = parse(state, click(9));
		expect(out.step).toEqual({ kind: "continue", callsLeft: 5 });
		expect(out.record).toEqual({ accepted: true });
		expect(lastResult(out.state)).toMatchObject({
			ok: false,
			error: "observation_stale",
			callsLeft: 5,
		});
		out = parse(out.state, click(1, "x", { ref: "e99" }));
		expect(lastResult(out.state)).toMatchObject({
			error: "ref_not_actionable",
		});
		// The third refusal of the same tool exceeds the two retries.
		expect(parse(out.state, click(9)).step).toEqual({
			kind: "failed",
			code: "tool_refused",
		});
	});

	test("invalid arguments are a rejection record and a refusal result", () => {
		const out = parse(start(), invoke("browser.page.click", { ref: "e3" }));
		expect(out.record).toEqual({
			accepted: false,
			rejection: "schema_violation",
		});
		expect(lastResult(out.state)).toMatchObject({
			ok: false,
			error: "invalid_arguments",
		});
	});

	test("a tool that is not offered is refused as unknown_tool", () => {
		const out = parse(
			start({ tools: ["browser.page.observe"] }),
			invoke("browser.page.back"),
		);
		expect(out.record).toEqual({ accepted: false, rejection: "unknown_tool" });
		expect(lastResult(out.state).error).toBe("unknown_tool");
	});

	test("no target tab: page tools are refused until a tab is selected", () => {
		let state = start({}, false);
		const refused = parse(state, invoke("browser.page.observe"));
		expect(lastResult(refused.state)).toMatchObject({
			error: "no_target_tab",
			detail: expect.stringContaining("tab_select"),
		});
		state = refused.state;
		const select = parse(
			state,
			invoke("browser.page.tab_select", { tabRef: TAB2 }),
		);
		expect(callOf(select.step).call).toEqual({
			kind: "tabs.select",
			tabRef: TAB2,
		});
		state = applyResult(select.state, confirmed(envelope(2, TAB2))).state;
		expect(
			callOf(parse(state, invoke("browser.page.observe")).step).call,
		).toEqual({
			kind: "observe",
			tabRef: TAB2,
		});
	});

	test("a Script variable is refused: no Script exists", () => {
		const raw = invoke("browser.page.type", {
			observationRef: ref(1),
			ref: "e2",
			element: "検索",
			variable: "keyword",
			purpose: "検索語",
			submit: false,
		});
		expect(lastResult(parse(start(), raw).state).error).toBe(
			"script_variable_unknown",
		);
	});
});

describe("applyResult", () => {
	const call = (raw: string, state = start()) => {
		const parsed = parse(state, raw);
		callOf(parsed.step);
		return parsed.state;
	};

	test("a new observation folds the old ones into one line and replaces the actionable refs", () => {
		let state = call(click(1));
		state = applyResult(state, confirmed(envelope(2))).state;
		const { messages } = prepareStep(state);
		const reference = JSON.parse(
			messages[1]!.content.split("\nREFERENCE=")[1]!,
		);
		expect(reference.observation).toBe(
			"失効済み: https://shop.example.com/search 「Shop」",
		);
		expect(lastResult(state)).toMatchObject({
			ok: true,
			state: "done",
			observation: { observationRef: ref(2) },
		});
		// The first observation is void, the second is the latest.
		expect(lastResult(parse(state, click(1)).state).error).toBe(
			"observation_stale",
		);
		expect(parse(state, click(2)).step.kind).toBe("call");
	});

	test("an operation without a new observation voids the old one", () => {
		let state = call(click(1));
		state = applyResult(state, confirmed()).state;
		expect(lastResult(state)).toEqual({
			ok: true,
			state: "done",
			callsLeft: 5,
		});
		expect(lastResult(parse(state, click(1)).state).error).toBe(
			"observation_stale",
		);
	});

	test("a failed operation leaves the observation actionable and the model may retry", () => {
		let state = call(click(1));
		const applied = applyResult(state, {
			kind: "operation",
			result: {
				operationId: "op",
				status: "failed",
				code: "tab_busy",
				retryable: true,
			},
		});
		expect(applied.step).toEqual({ kind: "continue", callsLeft: 5 });
		expect(lastResult(applied.state)).toMatchObject({
			error: "tab_busy",
			detail: "そのタブは別の作業が使っています。",
		});
		expect(parse(applied.state, click(1)).step.kind).toBe("call");
	});

	test("an indeterminate operation never invites a retry", () => {
		const state = call(click(1));
		const applied = applyResult(state, {
			kind: "operation",
			result: {
				operationId: "op",
				status: "indeterminate",
				code: "transport_lost",
				retryable: true,
			},
		});
		expect(applied.step).toEqual({ kind: "failed", code: "tool_refused" });
	});

	test("a refusal with retryable false ends the run; a retryable one counts against the retries", () => {
		const refused = (retryable: boolean): HostOutcome => ({
			kind: "refused",
			code: "tab_lost",
			retryable,
		});
		expect(applyResult(call(click(1)), refused(false)).step).toEqual({
			kind: "failed",
			code: "tool_refused",
		});
		const retry = applyResult(call(click(1)), refused(true));
		expect(retry.step).toEqual({ kind: "continue", callsLeft: 5 });
		expect(lastResult(retry.state)).toMatchObject({
			error: "tab_lost",
			detail: "そのタブは見つかりません。tabsで一覧を取り直してください。",
		});
	});

	test("a host refusal passes its details on", () => {
		const out = applyResult(call(click(1)), {
			kind: "refused",
			code: "approval_required",
			retryable: true,
			detail: { action: "click" },
		});
		expect(lastResult(out.state)).toMatchObject({
			error: "approval_required",
			action: "click",
		});
	});

	test("tabs are listed as views without the query", () => {
		const state = call(invoke("browser.page.tabs"));
		const applied = applyResult(state, {
			kind: "tabs",
			tabs: [
				{
					tabRef: TAB,
					title: "Shop",
					url: "https://shop.example.com/a?x=1#f",
					current: true,
				},
				{ tabRef: TAB2, current: false },
			],
		});
		expect(lastResult(applied.state)).toMatchObject({
			ok: true,
			current: TAB,
			tabs: [
				{
					tabRef: TAB,
					title: "Shop",
					place: "https://shop.example.com/a",
					active: true,
				},
				{ tabRef: TAB2, title: "", place: "", active: false },
			],
		});
	});

	test("a stop outcome ends the step and relays the host's words", () => {
		const state = call(click(1));
		expect(
			applyResult(state, {
				kind: "stop",
				code: "approval_required",
				text: "確認が要ります",
			}).step,
		).toEqual({
			kind: "stopped",
			code: "approval_required",
			text: "確認が要ります",
		});
	});

	test("a result without a call in flight is an error", () => {
		expect(() => applyResult(start(), confirmed())).toThrow(
			"core_state_invalid",
		);
	});

	test("the budget is shared by repairs and refusals", () => {
		let state = start({
			policy: { maxModelCalls: 4, retries: { default: 3 } },
		});
		state = parseStep(state, "x").state;
		state = parseStep(state, click(9)).state;
		expect(prepareStep(state).callsLeft).toBe(2);
	});

	test("the input state is never mutated", () => {
		const state = start();
		const before = JSON.stringify(state);
		const parsed = parseStep(state, click(1));
		applyResult(parsed.state, confirmed(envelope(2)));
		expect(JSON.stringify(state)).toBe(before);
	});
});

describe("tab_new without an observation", () => {
	test("the old tab is no longer targeted, so its refs cannot land on the new tab", () => {
		let state = parse(
			start(),
			invoke("browser.page.tab_new", { url: "https://example.com/" }),
		).state;
		state = applyResult(state, confirmed()).state;
		expect(lastResult(state)).toEqual({
			ok: true,
			state: "done",
			callsLeft: 5,
		});
		const refused = parse(state, click(1));
		expect(refused.step).toEqual({ kind: "continue", callsLeft: 4 });
		expect(lastResult(refused.state).error).toBe("no_target_tab");
		expect(parse(state, invoke("browser.page.observe")).step.kind).toBe(
			"continue",
		);
	});
});

describe("an ended run", () => {
	const ended = (state: CoreState) => {
		expect(() => prepareStep(state)).toThrow("core_run_ended");
		expect(() => parseStep(state, invoke("browser.page.observe"))).toThrow(
			"core_run_ended",
		);
		expect(() => applyResult(state, confirmed())).toThrow("core_run_ended");
		expect(parseCoreState(state)).toEqual(state);
	};

	test("finish, clarify, failure and stop each end it", () => {
		ended(
			parse(start(), JSON.stringify({ action: "finish", text: "完了" })).state,
		);
		ended(
			parse(start(), JSON.stringify({ action: "clarify", text: "どれ？" }))
				.state,
		);
		ended(parse(parse(start(), "x").state, "x").state);
		const typed = invoke("browser.page.type", {
			observationRef: ref(1),
			ref: "e2",
			element: "検索",
			value: "春の新作",
			quote: "新作を探して",
			purpose: "検索語",
			submit: false,
		});
		ended(parse(start(), typed).state);
		const called = parse(start(), click(1)).state;
		ended(
			applyResult(called, {
				kind: "stop",
				code: "approval_required",
				text: "確認",
			}).state,
		);
		ended(
			applyResult(called, {
				kind: "operation",
				result: {
					operationId: "op",
					status: "indeterminate",
					retryable: false,
				},
			}).state,
		);
	});

	test("a run that continues is not ended", () => {
		const parsed = parse(start(), invoke("browser.page.observe"));
		expect((parsed.state as { ended?: boolean }).ended).toBe(false);
		const applied = applyResult(parsed.state, {
			kind: "observation",
			observation: envelope(2),
		});
		expect((applied.state as { ended?: boolean }).ended).toBe(false);
	});
});

describe("shapeObservation", () => {
	test("cuts at node boundaries and lists the refs that remain", () => {
		const body = Array.from(
			{ length: 260 },
			(_, i) => `- button "b${i}" [ref=e${i}]`,
		).join("\n");
		const shaped = shapeObservation("arm0", {
			body,
			truncated: false,
			missing: [],
		});
		expect(shaped).toMatchObject({
			truncated: true,
			truncationReasons: ["refs"],
			refCount: 200,
		});
		expect(shaped.refs).toHaveLength(200);
		expect(shaped.body.split("\n")).toHaveLength(200);
	});

	test("a body within the limits is passed as it is", () => {
		expect(
			shapeObservation("arm0", { body: BODY, truncated: false, missing: [] }),
		).toEqual({
			body: BODY,
			truncated: false,
			truncationReasons: [],
			refCount: 3,
			refs: ["e1", "e2", "e3"],
		});
	});
});

describe("parseCoreState", () => {
	test("rejects what it did not write", () => {
		const state = start() as unknown as Record<string, unknown>;
		expect(parseCoreState(null)).toBeNull();
		expect(parseCoreState({})).toBeNull();
		expect(parseCoreState({ ...state, formatVersion: 2 })).toBeNull();
		expect(parseCoreState({ ...state, formatVersion: 0 })).toBeNull();
		expect(parseCoreState({ ...state, arm: "arm1" })).toBeNull();
		expect(parseCoreState({ ...state, extra: 1 })).toBeNull();
		expect(
			parseCoreState({
				...state,
				task: { ...(state.task as object), version: 2 },
			}),
		).toBeNull();
		expect(parseCoreState({ ...state, task: undefined })).toBeNull();
		// Eumenes' persisted job state (`{ v: 1, core, work }`) is not a core state.
		expect(
			parseCoreState({ v: 1, core: state.task, work: state.work }),
		).toBeNull();
	});

	test("rejects a state whose calls exceed its budget", () => {
		const state = start() as unknown as { task: { callsMade: number } };
		expect(
			parseCoreState({ ...state, task: { ...state.task, callsMade: 99 } }),
		).toBeNull();
	});

	test("every function refuses a foreign state", () => {
		const foreign = { formatVersion: 2, arm: "arm0" } as unknown as CoreState;
		expect(() => prepareStep(foreign)).toThrow("core_state_invalid");
		expect(() => parseStep(foreign, "{}")).toThrow("core_state_invalid");
		expect(() => applyResult(foreign, { kind: "tabs", tabs: [] })).toThrow(
			"core_state_invalid",
		);
	});
});

test("coreApi is the contract's CoreApi", () => {
	expect(Object.keys(coreApi).sort()).toEqual([
		"applyResult",
		"parseCoreState",
		"parseStep",
		"prepareStep",
		"shapeObservation",
		"startRun",
	]);
});
