import { describe, expect, test } from "bun:test";
import type { CoreState, StartRunInput } from "../../src/contracts/core.ts";
import type { PartResult } from "../../src/contracts/parts.ts";
import {
	applyResult,
	coreApi,
	parseCoreState,
	parseStep,
	prepareStep,
	shapeObservation,
	startRun,
	summarizePage,
} from "../../src/core/index.ts";
import { SYSTEM } from "../../src/core/arm1/texts.ts";
import { COMPACT, RESULTS, raw } from "./parts-fixtures.ts";

const page = summarizePage(
	raw(RESULTS, { url: "https://shop.example.com/", title: "検索結果" }),
	{
		pageId: "p1",
		maxItems: 50,
		maxHeadings: 5,
	},
).summary;

const start = (patch: Partial<StartRunInput> = {}, withPage = true) =>
	startRun({
		arm: "arm1",
		request: "電気ケトルの値段を調べて",
		policy: { maxModelCalls: 6, retries: { default: 1 } },
		nowMs: 1793600000000,
		reference: {
			allowedOrigins: ["https://*.example.com"],
			...(withPage ? { page } : {}),
		},
		...patch,
	});

const call = (part: string, args: Record<string, unknown> = {}) =>
	JSON.stringify({ part, args });
const open = (item: string) => call("item.open", { item });
const done = (evidence: string[] = []) =>
	call("done", {
		answer: "確認しました",
		evidence,
		outcome: "achieved",
		basis: evidence.length ? "observed" : "response",
	});
const result = (patch: Partial<PartResult> = {}): PartResult => ({
	part: "page.open",
	status: "completed",
	resultId: "r1",
	...patch,
});
const applied = (state: CoreState, patch?: Partial<PartResult>) =>
	applyResult(state, { kind: "part", result: result(patch) });

const messages = (state: CoreState) => prepareStep(state).messages;
const lastResult = (state: CoreState) =>
	JSON.parse(messages(state).at(-1)!.content.replace("PART_RESULT=", ""));

describe("startRun", () => {
	test("a system text, REFERENCE and the request, in plain JSON state", () => {
		const state = start();
		expect(JSON.parse(JSON.stringify(state))).toEqual(state);
		expect(state).toMatchObject({ formatVersion: 1, arm: "arm1" });
		const { messages: m, callsLeft, outputSchema } = prepareStep(state);
		expect(callsLeft).toBe(6);
		expect(m.map((x) => x.role)).toEqual(["system", "user", "user"]);
		expect(m[0]!.content).toBe(SYSTEM);
		expect(m[2]!.content).toBe("電気ケトルの値段を調べて");
		const reference = JSON.parse(m[1]!.content.replace("REFERENCE=", ""));
		expect(reference).toMatchObject({
			allowedOrigins: ["https://*.example.com"],
			callsLeft: 6,
			timeZone: "Asia/Tokyo",
			page: { page: "p1" },
		});
		expect(outputSchema).toMatchObject({
			type: "object",
			required: ["part", "args"],
		});
	});

	test("a brief that differs from the request is shown beside it", () => {
		const m = messages(start({ brief: "電気ケトルの価格を確認する" }));
		expect(m[1]!.content).toContain("handedOverRequest");
		expect(
			messages(start({ brief: "電気ケトルの値段を調べて" }))[1]!.content,
		).not.toContain("handedOverRequest");
	});

	test("the system text is the same whatever the run", () => {
		expect(messages(start({}, false))[0]).toEqual(messages(start())[0]);
	});

	test("unknown parts and out-of-bound policies are errors; an offered subset narrows the schema", () => {
		expect(() => start({ tools: ["page.teleport"] })).toThrow("unknown_tool");
		expect(() =>
			start({ policy: { maxModelCalls: 13, retries: { default: 1 } } }),
		).toThrow("core_state_invalid");
		const schema = prepareStep(start({ tools: ["page.open"] }))
			.outputSchema as {
			properties: { part: { enum: string[] }; args: { anyOf: unknown[] } };
		};
		expect(schema.properties.part.enum).toEqual(["page.open", "done", "ask"]);
		expect(schema.properties.args.anyOf).toHaveLength(3);
		const state = start({ tools: ["page.open"] });
		const rejected = parseStep(state, call("page.back"));
		expect(rejected.record).toEqual({
			accepted: false,
			rejection: "unknown_tool",
		});
		expect(rejected.step.kind).toBe("continue");
	});
});

describe("parseStep: valid parts", () => {
	test("a part becomes a host call, with the tool name and the budget", () => {
		const out = parseStep(
			start(),
			call("site.search", { query: "電気ケトル" }),
		);
		expect(out.record).toEqual({ accepted: true });
		expect(out.step).toEqual({
			kind: "call",
			tool: "site.search",
			call: {
				kind: "part",
				part: { part: "site.search", args: { query: "電気ケトル" } },
			},
			callsLeft: 5,
		});
	});

	test("an item the REFERENCE showed can be named", () => {
		expect(parseStep(start(), open("p1.i7")).step.kind).toBe("call");
		expect(
			parseStep(
				start(),
				call("form.fill", { fields: [{ item: "p1.i4", value: "x" }] }),
			).step.kind,
		).toBe("call");
	});

	test("done is finish with its evidence and ask is clarify", () => {
		let state = parseStep(
			start(),
			call("page.open", { url: "https://shop.example.com/" }),
		).state;
		state = applied(state, { resultId: "r7" }).state;
		const finish = parseStep(state, done(["r7"]));
		expect(finish.step).toEqual({
			kind: "finish",
			text: "確認しました",
			refs: ["r7"],
			outcome: "achieved",
			basis: "observed",
		});
		const ask = parseStep(
			start(),
			call("ask", { question: "どのサイトですか。" }),
		);
		expect(ask.step).toEqual({ kind: "clarify", text: "どのサイトですか。" });
	});

	test("JSON in a fence or with a trailing comma is read like Arm 0's output", () => {
		const fenced = `\`\`\`json\n${call("page.back")}\n\`\`\``;
		expect(parseStep(start(), fenced).step.kind).toBe("call");
	});
});

describe("parseStep: rejections", () => {
	const reject = (raw: string, state = start()) => parseStep(state, raw);
	const issues = (state: CoreState) =>
		JSON.parse(messages(state).at(-1)!.content.split("REJECTED_OUTPUT=")[1]!)
			.issues;

	test("not JSON, and not a part", () => {
		expect(reject("検索します").record).toEqual({
			accepted: false,
			rejection: "unparsable_json",
		});
		const bad = reject(call("page.open", { url: 1 }));
		expect(bad.record).toEqual({
			accepted: false,
			rejection: "schema_violation",
		});
		expect(issues(bad.state)).toEqual([
			{ path: "args.url", code: "invalid_type" },
		]);
		expect(reject(call("page.fly")).record.rejection).toBe("schema_violation");
		expect(reject(call("page.back", { extra: 1 })).record.rejection).toBe(
			"schema_violation",
		);
		expect(
			reject(call("page.read", { target: null, maxChars: 5 })).record.rejection,
		).toBe("schema_violation");
	});

	test("page.find needs text or role", () => {
		const out = reject(call("page.find", { text: null, role: null }));
		expect(out.record).toEqual({ accepted: false, rejection: "action_fields" });
		expect(issues(out.state)).toEqual([
			{ path: "args", code: "text_or_role_required" },
		]);
		expect(
			reject(call("page.find", { text: "", role: null })).record.accepted,
		).toBe(false);
		expect(
			reject(call("page.find", { text: null, role: "button" })).record.accepted,
		).toBe(true);
	});

	test("page.wait needs text or seconds", () => {
		const out = reject(call("page.wait", { text: null, seconds: null }));
		expect(issues(out.state)).toEqual([
			{ path: "args", code: "text_or_seconds_required" },
		]);
		expect(
			reject(call("page.wait", { text: null, seconds: 2 })).record.accepted,
		).toBe(true);
		expect(
			reject(call("page.wait", { text: "完了", seconds: null })).record
				.accepted,
		).toBe(true);
	});

	test("page.capture of an item needs an item", () => {
		const out = reject(call("page.capture", { range: "item", item: null }));
		expect(issues(out.state)).toEqual([
			{ path: "args.item", code: "item_required" },
		]);
		expect(
			reject(call("page.capture", { range: "full", item: null })).record
				.accepted,
		).toBe(true);
		expect(
			reject(call("page.capture", { range: "item", item: "p1.i6" })).record
				.accepted,
		).toBe(true);
	});

	test("an item the AI was not shown is refused, and so is an item of an older page", () => {
		const unknown = reject(open("p1.i99"));
		expect(unknown.record).toEqual({
			accepted: false,
			rejection: "unknown_reference",
		});
		expect(issues(unknown.state)).toEqual([
			{ path: "args.item", code: "unknown_item" },
		]);
		expect(reject(open("p2.i1")).record.accepted).toBe(false);
		expect(reject(open("p1.i6"), start({}, false)).record.accepted).toBe(false);
		const fill = reject(
			call("form.fill", {
				fields: [
					{ item: "p1.i4", value: "a" },
					{ item: "p1.i88", value: "b" },
				],
			}),
		);
		expect(issues(fill.state)).toEqual([
			{ path: "args.fields.1.item", code: "unknown_item" },
		]);
	});

	test("done may cite only results the AI was shown", () => {
		const out = reject(done(["r1"]));
		expect(out.record).toEqual({
			accepted: false,
			rejection: "unknown_reference",
		});
		expect(issues(out.state)).toEqual([
			{ path: "args.evidence.0", code: "unknown_result" },
		]);
		expect(reject(done([])).step.kind).toBe("finish");
	});

	test("the issues never echo what the output said (only the short preview does, as in Arm 0)", () => {
		const out = reject(call("page.open", { url: { secret: "s3cr3t-value" } }));
		expect(JSON.stringify(issues(out.state))).not.toContain("s3cr3t");
		expect(issues(out.state)).toEqual([
			{ path: "args.url", code: "invalid_type" },
		]);
	});

	test("wrong arg names come back with the part's args shape; a bad part name or bad JSON does not", () => {
		const payload = (out: ReturnType<typeof reject>) =>
			JSON.parse(
				messages(out.state).at(-1)!.content.split("REJECTED_OUTPUT=")[1]!,
			);
		const wrong = reject(call("page.read", { page: null, chars: 2500 }));
		expect(payload(wrong).expectedArgs).toBe(
			'{"target":"p3.i12 か null","maxChars":3000}',
		);
		expect(
			payload(reject(call("page.find", { text: "x" }))).expectedArgs,
		).toContain('"role"');
		expect(payload(reject("x")).expectedArgs).toBeUndefined();
		expect(
			payload(reject(JSON.stringify({ part: "nope", args: {} }))).expectedArgs,
		).toBeUndefined();
	});

	test("one repair per output, then the run fails", () => {
		const first = reject("x");
		expect(first.step).toEqual({ kind: "continue", callsLeft: 5 });
		expect(messages(first.state).at(-1)!.content).toContain("REJECTED_OUTPUT=");
		const second = parseStep(first.state, "y");
		expect(second.step).toEqual({ kind: "failed", code: "invalid_contract" });
		expect(() => prepareStep(second.state)).toThrow("core_run_ended");
	});

	test("a valid call resets the repair", () => {
		let state = reject("x").state;
		state = parseStep(state, call("page.back")).state;
		state = applied(state).state;
		expect(parseStep(state, "x").step.kind).toBe("continue");
	});
});

describe("content blocks", () => {
	// RESULTS: p1.i6 is `main`, a content block; p1.i7 is a link.
	const blockIds = (state: CoreState) =>
		(state as unknown as { known: { blocks: string[] } }).known.blocks;

	test("the REFERENCE page's blocks are known as blocks", () => {
		expect(blockIds(start())).toEqual(["p1.i6"]);
	});

	test("page.read and page.capture accept a block as well as a control", () => {
		for (const id of ["p1.i6", "p1.i7"]) {
			expect(
				parseStep(start(), call("page.read", { target: id, maxChars: 500 }))
					.step.kind,
			).toBe("call");
			expect(
				parseStep(start(), call("page.capture", { range: "item", item: id }))
					.step.kind,
			).toBe("call");
		}
	});

	test("item.open refuses a block, naming the rule, and accepts a control", () => {
		const out = parseStep(start(), open("p1.i6"));
		expect(out.record).toEqual({ accepted: false, rejection: "action_fields" });
		expect(out.step.kind).toBe("continue");
		const issues = JSON.parse(
			messages(out.state).at(-1)!.content.split("REJECTED_OUTPUT=")[1]!,
		).issues;
		expect(issues).toEqual([{ path: "args.item", code: "item_not_openable" }]);
		expect(parseStep(start(), open("p1.i7")).step.kind).toBe("call");
	});

	test("blocks from a result are remembered per page and forgotten with the page", () => {
		let state = parseStep(
			start(),
			call("page.find", { text: null, role: "article" }),
		).state;
		state = applied(state, {
			part: "page.find",
			candidates: [{ item: "p1.i40", role: "article", name: "商品の詳細" }],
		}).state;
		expect(blockIds(state)).toEqual(["p1.i6", "p1.i40"]);
		expect(parseStep(state, open("p1.i40")).record.rejection).toBe(
			"action_fields",
		);
		state = applied(parseStep(state, call("page.back")).state, {
			page: {
				...page,
				page: "p2",
				items: [{ item: "p2.i1", role: "table", name: "" }],
			},
		}).state;
		expect(blockIds(state)).toEqual(["p2.i1"]);
	});

	test("the system text says what blocks are for", () => {
		expect(SYSTEM).toContain("item.openでは開けません");
	});
});

describe("budget", () => {
	test("the last call is reserved for done or ask", () => {
		let state = start({
			policy: { maxModelCalls: 2, retries: { default: 1 } },
		});
		state = parseStep(state, call("page.back")).state;
		state = applied(state).state;
		expect(prepareStep(state).callsLeft).toBe(1);
		const last = parseStep(state, call("page.back"));
		expect(last.step).toEqual({ kind: "failed", code: "invoke_on_last_call" });
		expect(last.record).toEqual({
			accepted: false,
			rejection: "invoke_on_last_call",
		});
		expect(parseStep(state, done()).step.kind).toBe("finish");
		expect(parseStep(state, call("ask", { question: "?" })).step.kind).toBe(
			"clarify",
		);
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

	test("repairs and results share the budget", () => {
		let state = start({
			policy: { maxModelCalls: 4, retries: { default: 1 } },
		});
		state = parseStep(state, "x").state;
		state = parseStep(state, call("page.back")).state;
		expect(prepareStep(applied(state).state).callsLeft).toBe(2);
	});

	test("a call cannot be parsed while the previous call has no result", () => {
		const { state } = parseStep(start(), call("page.back"));
		expect(() => parseStep(state, call("page.back"))).toThrow(
			"task_state_invalid",
		);
	});
});

describe("applyResult", () => {
	const called = (raw = call("page.back")) => parseStep(start(), raw).state;

	test("the result is appended as one PART_RESULT after the AI's own output", () => {
		const before = messages(called());
		const out = applied(called(), { page: { ...page, page: "p2" } });
		expect(out.step).toEqual({ kind: "continue", callsLeft: 5 });
		const after = messages(out.state);
		expect(after).toHaveLength(before.length + 2);
		expect(after.at(-2)).toEqual({
			role: "assistant",
			content: call("page.back"),
		});
		expect(after.at(-1)!.content.startsWith("PART_RESULT=")).toBe(true);
		expect(lastResult(out.state)).toMatchObject({
			part: "page.open",
			status: "completed",
			resultId: "r1",
			callsLeft: 5,
		});
	});

	test("earlier messages are never rewritten: the start stays byte-identical across steps", () => {
		let state = start();
		const seen: string[][] = [];
		for (const [i, raw] of [
			call("page.back"),
			open("p1.i7"),
			call("page.wait", { text: "x", seconds: null }),
		].entries()) {
			state = parseStep(state, raw).state;
			state = applied(state, {
				resultId: `r${i + 1}`,
				page: i === 1 ? { ...page, page: "p2" } : page,
			}).state;
			seen.push(messages(state).map((m) => m.content));
		}
		for (let i = 1; i < seen.length; i++)
			expect(seen[i]!.slice(0, seen[i - 1]!.length)).toEqual(seen[i - 1]!);
		expect(seen[0]![0]).toBe(SYSTEM);
		expect(seen.at(-1)).toHaveLength(3 + 2 * 3);
	});

	test("a repair notice is appended too, and nothing before it changes", () => {
		const before = messages(start());
		const after = messages(parseStep(start(), "x").state);
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after).toHaveLength(before.length + 1);
	});

	test("page text is enclosed as data and the message stays bounded", () => {
		const read = (text: string): Partial<PartResult> => ({
			part: "page.read",
			read: { text, charCount: text.length, truncated: false, url: "/a" },
		});
		const small = lastResult(applied(called(), read("本文です")).state);
		expect(small.read).toMatchObject({
			untrusted: true,
			text: "本文です",
			truncated: false,
		});
		const big = applied(called(), read("あ".repeat(200_000))).state;
		const content = messages(big).at(-1)!.content;
		expect(content.length).toBeLessThanOrEqual(96_000 + 20);
		const view = lastResult(big);
		expect(view.read.truncated).toBe(true);
		expect(view.resultId).toBe("r1");
		expect(view.callsLeft).toBe(5);
	});

	test("the AI may name the items of the latest page and cite the results it saw", () => {
		let state = parseStep(start(), call("page.back")).state;
		const p2 = {
			...page,
			page: "p2",
			items: [{ item: "p2.i1", role: "link", name: "x" }],
		};
		state = applied(state, { resultId: "r5", page: p2 }).state;
		expect(parseStep(state, open("p2.i1")).step.kind).toBe("call");
		// The first page's items are gone with the page.
		expect(parseStep(state, open("p1.i6")).record.accepted).toBe(false);
		expect(parseStep(state, done(["r5"])).step.kind).toBe("finish");
	});

	test("candidates, list entries and form fields add ids of the same page", () => {
		let state = parseStep(
			start(),
			call("page.find", { text: "x", role: null }),
		).state;
		state = applied(state, {
			part: "page.find",
			resultId: "r2",
			candidates: [{ item: "p1.i50", role: "link", name: "x" }],
		}).state;
		state = applied(
			parseStep(state, call("page.list", { kind: "links", limit: 5 })).state,
			{
				part: "page.list",
				resultId: "r3",
				list: {
					kind: "links",
					entries: [{ item: "p1.i51", title: "t" }, { title: "no item" }],
					truncated: false,
				},
			},
		).state;
		state = applied(
			parseStep(state, call("form.inspect", { form: null })).state,
			{
				part: "form.inspect",
				resultId: "r4",
				form: {
					fields: [
						{ item: "p1.i52", label: "l", kind: "textbox", filled: false },
					],
					submit: [{ item: "p1.i53", role: "button", name: "送信" }],
				},
			},
		).state;
		for (const id of ["p1.i7", "p1.i50", "p1.i51", "p1.i52", "p1.i53"])
			expect(parseStep(state, open(id)).record.accepted).toBe(true);
		expect(parseStep(state, done(["r2", "r3", "r4"])).step.kind).toBe("finish");
	});

	test("an indeterminate part result handed in by a host ends the run and never invites a retry", () => {
		const out = applied(called(), {
			status: "indeterminate",
			code: "transport_lost",
		});
		expect(out.step).toEqual({ kind: "failed", code: "tool_refused" });
		expect(() => parseStep(out.state, call("page.back"))).toThrow(
			"core_run_ended",
		);
	});

	test("a part that needs approval stops the run", () => {
		const out = applied(called(), {
			status: "needs_approval",
			code: "approval_required",
			approval: { action: "submit" },
		});
		expect(out.step).toMatchObject({
			kind: "stopped",
			code: "approval_required",
		});
		expect(() => prepareStep(out.state)).toThrow("core_run_ended");
	});

	test("a failed or partial part is data for the AI, not the end", () => {
		for (const status of ["failed", "partial"] as const) {
			const out = applied(called(), { status, code: "target_not_found" });
			expect(out.step).toEqual({ kind: "continue", callsLeft: 5 });
			expect(lastResult(out.state)).toMatchObject({
				status,
				code: "target_not_found",
			});
		}
	});

	test("stop relays the host's words and ends the run", () => {
		const out = applyResult(called(), {
			kind: "stop",
			code: "approval_required",
			text: "確認が要ります",
		});
		expect(out.step).toEqual({
			kind: "stopped",
			code: "approval_required",
			text: "確認が要ります",
		});
		expect(() =>
			applyResult(out.state, { kind: "stop", code: "x", text: "x" }),
		).toThrow("core_run_ended");
	});

	test("a refusal counts against the part's retries; retryable false ends the run", () => {
		const refused = (retryable: boolean) =>
			applyResult(called(), {
				kind: "refused",
				code: "origin_not_allowed",
				retryable,
				detail: { origin: "x" },
			});
		const first = refused(true);
		expect(first.step).toEqual({ kind: "continue", callsLeft: 5 });
		expect(lastResult(first.state)).toMatchObject({
			part: "page.back",
			status: "refused",
			code: "origin_not_allowed",
			origin: "x",
		});
		expect(refused(false).step).toEqual({
			kind: "failed",
			code: "tool_refused",
		});
		let state = start();
		state = parseStep(state, call("page.back")).state;
		state = applyResult(state, {
			kind: "refused",
			code: "c",
			retryable: true,
		}).state;
		state = parseStep(state, call("page.back")).state;
		expect(
			applyResult(state, { kind: "refused", code: "c", retryable: true }).step,
		).toEqual({
			kind: "failed",
			code: "tool_refused",
		});
	});

	test("outcomes of Arm 0 are not Arm 1's, and a result needs a call in flight", () => {
		expect(() => applyResult(called(), { kind: "tabs", tabs: [] })).toThrow(
			"unsupported_outcome",
		);
		expect(() => applied(start())).toThrow("core_state_invalid");
	});

	test("the input state is never mutated", () => {
		const state = called();
		const before = JSON.stringify(state);
		applied(state);
		expect(JSON.stringify(state)).toBe(before);
	});
});

describe("state and dispatch", () => {
	test("parseCoreState reads Arm 1 states and rejects foreign ones", () => {
		const state = start();
		expect(parseCoreState(state)).toEqual(state);
		expect(parseCoreState({ ...state, formatVersion: 2 })).toBeNull();
		expect(parseCoreState({ ...state, arm: "arm2" })).toBeNull();
		expect(parseCoreState({ ...state, extra: 1 })).toBeNull();
		expect(parseCoreState({ ...state, messages: [] })).toBeNull();
		expect(parseCoreState({ ...state, callsMade: 99 })).toBeNull();
		// An Arm 0 state is not an Arm 1 state and vice versa.
		expect(parseCoreState({ ...state, arm: "arm0" })).toBeNull();
	});

	test("every function dispatches by the state's arm, and an unknown one is an error", () => {
		expect(() =>
			startRun({
				arm: "arm2" as "arm1",
				request: "x",
				policy: { maxModelCalls: 3, retries: {} },
				nowMs: 0,
			}),
		).toThrow("unknown_arm");
		const foreign = { formatVersion: 1, arm: "arm1" } as unknown as CoreState;
		expect(() => prepareStep(foreign)).toThrow("core_state_invalid");
		expect(() => parseStep(foreign, "{}")).toThrow("core_state_invalid");
		expect(() =>
			applyResult(foreign, { kind: "stop", code: "x", text: "x" }),
		).toThrow("core_state_invalid");
	});

	test("shapeObservation keeps the whole body for Arm 1", () => {
		const shaped = shapeObservation("arm1", raw(COMPACT));
		expect(shaped).toMatchObject({
			body: COMPACT,
			truncated: false,
			truncationReasons: [],
			refCount: 6,
		});
		expect(shaped.refs).toEqual(["e1", "e26", "e27", "e322", "e323", "e28"]);
	});

	test("coreApi still has the six functions", () => {
		expect(Object.keys(coreApi)).toHaveLength(6);
	});
});
