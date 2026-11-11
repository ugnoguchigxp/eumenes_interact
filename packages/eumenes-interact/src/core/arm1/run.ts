import type {
	AppliedStep,
	ChatMessage,
	CoreState,
	HostOutcome,
	ParsedStep,
	ParseRecord,
	ParseRejectionCode,
	PreparedStep,
	StartRunInput,
} from "../../contracts/core.ts";
import {
	PART_NAMES,
	partCallSchema,
	type PartCall,
	type PartResult,
} from "../../contracts/parts.ts";
import { decodeLlmJson } from "../shared/json.ts";
import { promptTime } from "../shared/text.ts";
import { partCallJsonSchemaFor } from "../parts/schema.ts";
import { BLOCK_ROLES } from "../parts/snapshot.ts";
import { CORRECTION, PART_ARGS, SYSTEM } from "./texts.ts";
import { parseArm1State, type Arm1State } from "./state.ts";

/**
 * Arm 1 (plan.md §6.4): the AI composes registered parts, one call per inference. The conversation is
 * append-only (system, REFERENCE, the request, then for each step the AI's output and the part's result), so a
 * provider's prompt cache keeps reading the start of it. A part's page text is enclosed as data.
 */

const PART_RESULT_MAX_CHARS = 96_000;
const REJECTED_PREVIEW_CHARS = 2000;
const MAX_ISSUES = 8;
const MAX_KNOWN_ITEMS = 500;
const MAX_KNOWN_RESULTS = 64;

const ALWAYS = ["done", "ask"];

function stateOf(state: CoreState): Arm1State {
	const parsed = parseArm1State(state);
	if (!parsed) throw new Error("core_state_invalid");
	return parsed;
}
function liveStateOf(state: CoreState): Arm1State {
	const current = stateOf(state);
	if (current.ended) throw new Error("core_run_ended");
	return current;
}

const pageOf = (item: string) => item.split(".")[0]!;

/** The page and item ids a host-built page summary shows. */
function idsOfSummary(page: unknown) {
	const summary = page as { page?: unknown; items?: unknown } | null;
	if (!summary || typeof summary.page !== "string") return null;
	const shown = Array.isArray(summary.items)
		? summary.items.flatMap((i: { item?: unknown; role?: unknown }) =>
				typeof i?.item === "string"
					? [{ item: i.item, role: typeof i.role === "string" ? i.role : "" }]
					: [],
			)
		: [];
	return {
		page: summary.page,
		items: shown.map((i) => i.item),
		blocks: shown
			.filter((i) => BLOCK_ROLES.includes(i.role))
			.map((i) => i.item),
	};
}

export function startRun(input: StartRunInput): CoreState {
	if (input.arm !== "arm1") throw new Error("unknown_arm");
	const unknown = input.tools?.find(
		(id) => !(PART_NAMES as readonly string[]).includes(id),
	);
	if (unknown !== undefined) throw new Error(`unknown_tool:${unknown}`);
	const { page, ...rest } = (input.reference ?? {}) as Record<string, unknown>;
	const reference = {
		...(input.brief && input.brief !== input.request
			? { handedOverRequest: input.brief }
			: {}),
		...rest,
		...(page === undefined ? {} : { page }),
		callsLeft: input.policy.maxModelCalls,
		...promptTime(input.nowMs),
	};
	const first = idsOfSummary(page);
	const state: Arm1State = {
		formatVersion: 1,
		arm: "arm1",
		policy: {
			maxModelCalls: input.policy.maxModelCalls,
			retries: { ...input.policy.retries },
		},
		parts: input.tools
			? [...new Set([...input.tools, ...ALWAYS])]
			: [...PART_NAMES],
		callsMade: 0,
		repaired: false,
		refusals: {},
		pendingRaw: null,
		pending: null,
		messages: [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: `REFERENCE=${JSON.stringify(reference)}` },
			{ role: "user", content: input.request },
		],
		known: {
			page: first?.page ?? null,
			items: first?.items.slice(-MAX_KNOWN_ITEMS) ?? [],
			blocks: first?.blocks.slice(-MAX_KNOWN_ITEMS) ?? [],
			results: [],
		},
		ended: false,
	};
	// Parsing the state checks the policy against the bounds a stored state has.
	return stateOf(state);
}

export function prepareStep(state: CoreState): PreparedStep {
	const current = liveStateOf(state);
	return {
		messages: current.messages.map((m) => ({ ...m })),
		callsLeft: current.policy.maxModelCalls - current.callsMade,
		outputSchema: partCallJsonSchemaFor(current.parts),
	};
}

type Issue = { path: string; code: string };

/** The item ids a part call names, with where they sit. */
function itemsOf(part: PartCall): { path: string; item: string }[] {
	switch (part.part) {
		case "site.search":
			return part.args.field
				? [{ path: "args.field", item: part.args.field }]
				: [];
		case "page.find":
		case "page.list":
			return part.args.within
				? [{ path: "args.within", item: part.args.within }]
				: [];
		case "item.open":
			return [{ path: "args.item", item: part.args.item }];
		case "page.read":
			return part.args.target
				? [{ path: "args.target", item: part.args.target }]
				: [];
		case "page.capture":
			return part.args.item
				? [{ path: "args.item", item: part.args.item }]
				: [];
		case "form.inspect":
			return part.args.form
				? [{ path: "args.form", item: part.args.form }]
				: [];
		case "form.fill":
			return part.args.fields.map((f, i) => ({
				path: `args.fields.${i}.item`,
				item: f.item,
			}));
		case "form.submit":
			return [{ path: "args.button", item: part.args.button }];
		default:
			return [];
	}
}

/**
 * What the contract's types cannot say: a part needs the arguments that make it meaningful, and an item or result
 * the AI names must be one it was shown.
 */
function checkPart(
	part: PartCall,
	known: Arm1State["known"],
	allowed: readonly string[],
): { code: ParseRejectionCode; issues: Issue[] } | null {
	if (!allowed.includes(part.part))
		return {
			code: "unknown_tool",
			issues: [{ path: "part", code: "part_not_offered" }],
		};
	const missing: Issue[] = [];
	if (
		part.part === "page.wait" &&
		!part.args.text &&
		part.args.seconds === null
	)
		missing.push({ path: "args", code: "text_or_seconds_required" });
	if (
		part.part === "page.capture" &&
		part.args.range === "item" &&
		part.args.item === null
	)
		missing.push({ path: "args.item", code: "item_required" });
	// A content block can be read or captured, not opened.
	if (part.part === "item.open" && known.blocks.includes(part.args.item))
		missing.push({ path: "args.item", code: "item_not_openable" });
	if (missing.length) return { code: "action_fields", issues: missing };
	const unknown: Issue[] = [
		...itemsOf(part)
			.filter(({ item }) => !known.items.includes(item))
			.map(({ path }) => ({ path, code: "unknown_item" })),
		...(part.part === "done"
			? part.args.evidence
					.map((id, i) => ({ id, i }))
					.filter(({ id }) => !known.results.includes(id))
					.map(({ i }) => ({
						path: `args.evidence.${i}`,
						code: "unknown_result",
					}))
			: []),
	];
	return unknown.length ? { code: "unknown_reference", issues: unknown } : null;
}

const rejectedMessage = (
	raw: string,
	issues: readonly Issue[],
	callsLeft: number,
	expected?: string,
): ChatMessage => ({
	role: "user",
	content: `${CORRECTION}\nREJECTED_OUTPUT=${JSON.stringify({
		preview: raw.slice(0, REJECTED_PREVIEW_CHARS),
		issues: issues.slice(0, MAX_ISSUES),
		...(expected ? { expectedArgs: expected } : {}),
		callsLeft,
	})}`,
});

/** The args shape of the part a rejected call named, when it named a known one with wrong args. */
function expectedArgsOf(
	value: unknown,
	issues: readonly Issue[],
): string | undefined {
	if (!issues.some((i) => i.path.startsWith("args"))) return undefined;
	const name =
		typeof value === "object" && value !== null
			? (value as { part?: unknown }).part
			: undefined;
	return typeof name === "string" && Object.hasOwn(PART_ARGS, name)
		? PART_ARGS[name]
		: undefined;
}

export function parseStep(
	state: CoreState,
	raw: string,
): { state: CoreState; step: ParsedStep; record: ParseRecord } {
	const current = liveStateOf(state);
	if (current.pendingRaw !== null) throw new Error("task_state_invalid");
	const call = current.callsMade + 1;
	const max = current.policy.maxModelCalls;
	if (call > max) throw new Error("task_state_invalid");
	const counted: Arm1State = { ...current, callsMade: call };

	let rejected: { code: ParseRejectionCode; issues: Issue[] } | null = null;
	let part: PartCall | null = null;
	let value: unknown;
	try {
		value = decodeLlmJson(raw).value;
	} catch {
		rejected = {
			code: "unparsable_json",
			issues: [{ path: "", code: "unparsable_json" }],
		};
	}
	if (!rejected) {
		const parsed = partCallSchema.safeParse(value);
		if (parsed.success) {
			part = parsed.data;
			rejected = checkPart(part, current.known, current.parts);
		} else
			rejected = {
				code: "schema_violation",
				issues: parsed.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
					path: issue.path.map(String).join("."),
					code: issue.code,
				})),
			};
	}
	if (rejected || !part) {
		const record: ParseRecord = { accepted: false, rejection: rejected!.code };
		if (current.repaired || call === max)
			return {
				state: { ...counted, ended: true },
				step: {
					kind: "failed",
					code: current.repaired ? "invalid_contract" : "turn_limit",
				},
				record,
			};
		return {
			state: {
				...counted,
				repaired: true,
				messages: [
					...current.messages,
					rejectedMessage(
						raw,
						rejected!.issues,
						max - call,
						rejected!.code === "schema_violation"
							? expectedArgsOf(value, rejected!.issues)
							: undefined,
					),
				],
			},
			step: { kind: "continue", callsLeft: max - call },
			record,
		};
	}
	const valid: Arm1State = { ...counted, repaired: false };
	if (part.part === "done")
		return {
			state: { ...valid, ended: true },
			step: {
				kind: "finish",
				text: part.args.answer,
				refs: part.args.evidence,
				outcome: part.args.outcome,
				basis: part.args.basis,
			},
			record: { accepted: true },
		};
	if (part.part === "ask")
		return {
			state: { ...valid, ended: true },
			step: { kind: "clarify", text: part.args.question },
			record: { accepted: true },
		};
	// The last call cannot read a part's result: it is reserved for done or ask.
	if (call === max)
		return {
			state: { ...valid, ended: true },
			step: { kind: "failed", code: "invoke_on_last_call" },
			record: { accepted: false, rejection: "invoke_on_last_call" },
		};
	return {
		state: { ...valid, pendingRaw: raw, pending: { part: part.part } },
		step: {
			kind: "call",
			tool: part.part,
			call: { kind: "part", part },
			callsLeft: max - call,
		},
		record: { accepted: true },
	};
}

/**
 * The members of a result that hold text the page wrote (titles, URLs, item names, headings, entries, field
 * labels and options, the element an approval names, a read's text). Everything else in a result is the host's.
 */
const PAGE_MEMBERS = [
	"page",
	"candidates",
	"list",
	"read",
	"capture",
	"preview",
	"searchUrls",
	"form",
	"approval",
] as const;

/**
 * The result as the AI reads it: every page-derived member is marked as data from the page (design R20; field
 * names stay as they are), and the message stays bounded. An object member carries `untrusted: true` itself;
 * `untrustedFields` names all of the members present, which is the only mark an array (`candidates`) can have.
 */
function resultMessage(result: PartResult, callsLeft: number): ChatMessage {
	const marked = (member: (typeof PAGE_MEMBERS)[number]) =>
		!Array.isArray(result[member]) && result[member]
			? { [member]: { untrusted: true, ...result[member] } }
			: {};
	const present = PAGE_MEMBERS.filter((member) => result[member] !== undefined);
	const view = (text?: string) => ({
		...result,
		...Object.assign({}, ...PAGE_MEMBERS.map(marked)),
		...(result.read && text !== undefined
			? { read: { untrusted: true, ...result.read, text, truncated: true } }
			: {}),
		...(present.length > 0 ? { untrustedFields: present } : {}),
		callsLeft,
	});
	let json = JSON.stringify(view());
	if (json.length > PART_RESULT_MAX_CHARS && result.read) {
		// Cut the page text, never the structure around it.
		const over = json.length - PART_RESULT_MAX_CHARS;
		const keep = Math.max(0, result.read.text.length - over - 64);
		json = JSON.stringify(view(result.read.text.slice(0, keep)));
	}
	if (json.length > PART_RESULT_MAX_CHARS) {
		// The preview is JSON inside JSON, so quotes double: cut until the whole message fits.
		const full = json;
		const wrap = (n: number) =>
			JSON.stringify({
				truncated: true,
				resultId: result.resultId,
				preview: full.slice(0, n),
			});
		let keep = PART_RESULT_MAX_CHARS;
		json = wrap(keep);
		while (json.length > PART_RESULT_MAX_CHARS && keep > 0) {
			keep = Math.max(0, keep - (json.length - PART_RESULT_MAX_CHARS));
			json = wrap(keep);
		}
	}
	return { role: "user", content: `PART_RESULT=${json}` };
}

/** What the AI may name after this result. */
function learn(
	known: Arm1State["known"],
	result: PartResult,
): Arm1State["known"] {
	// Only these carry a role: a list entry is a link, and a form field is never a content block.
	const shown = [
		...(result.page?.items ?? []),
		...(result.candidates ?? []),
		...(result.form?.submit ?? []),
	];
	const ids = [
		...shown.map((i) => i.item),
		...(result.list?.entries.flatMap((e) => (e.item ? [e.item] : [])) ?? []),
		...(result.form?.fields.map((f) => f.item) ?? []),
	];
	const page = result.page?.page ?? (ids[0] ? pageOf(ids[0]) : known.page);
	const same = page === known.page;
	const items = same ? [...known.items] : [];
	const blocks = same ? [...known.blocks] : [];
	for (const id of ids)
		if (pageOf(id) === page && !items.includes(id)) items.push(id);
	for (const i of shown)
		if (
			BLOCK_ROLES.includes(i.role) &&
			pageOf(i.item) === page &&
			!blocks.includes(i.item)
		)
			blocks.push(i.item);
	return {
		page,
		items: items.slice(-MAX_KNOWN_ITEMS),
		blocks: blocks.slice(-MAX_KNOWN_ITEMS),
		results: [
			...known.results.filter((r) => r !== result.resultId),
			result.resultId,
		].slice(-MAX_KNOWN_RESULTS),
	};
}

const retriesFor = (retries: Readonly<Record<string, number>>, part: string) =>
	retries[part] ?? retries.default ?? 1;

export function applyResult(
	state: CoreState,
	outcome: HostOutcome,
): { state: CoreState; step: AppliedStep } {
	const current = liveStateOf(state);
	const pending = current.pending;
	if (!pending || current.pendingRaw === null)
		throw new Error("core_state_invalid");
	if (outcome.kind === "stop")
		return {
			state: { ...current, ended: true, pending: null },
			step: { kind: "stopped", code: outcome.code, text: outcome.text },
		};
	if (outcome.kind !== "part" && outcome.kind !== "refused")
		throw new Error("unsupported_outcome");
	const callsLeft = current.policy.maxModelCalls - current.callsMade;
	const appended = (user: ChatMessage): Arm1State["messages"] => [
		...current.messages,
		{ role: "assistant", content: current.pendingRaw! },
		user,
	];
	const finished = (step: AppliedStep, patch: Partial<Arm1State> = {}) => ({
		state: {
			...current,
			...patch,
			pending: null,
			pendingRaw: null,
			ended: true,
		},
		step,
	});
	if (outcome.kind === "refused") {
		const count = (current.refusals[pending.part] ?? 0) + 1;
		const refusals = { ...current.refusals, [pending.part]: count };
		if (
			outcome.retryable === false ||
			count > retriesFor(current.policy.retries, pending.part)
		)
			return finished({ kind: "failed", code: "tool_refused" }, { refusals });
		const content = JSON.stringify({
			part: pending.part,
			status: "refused",
			code: outcome.code,
			...outcome.detail,
			callsLeft,
		});
		return {
			state: {
				...current,
				refusals,
				pending: null,
				pendingRaw: null,
				messages: appended({ role: "user", content: `PART_RESULT=${content}` }),
			},
			step: { kind: "continue", callsLeft },
		};
	}
	const { result } = outcome;
	// A part that may have reached the page ends the run; so does one that needs the user's approval. The
	// package's part executor never returns `indeterminate` as a result: it ends the run itself (`Executed`
	// "end") before this is called. The branch is for a host that does hand one in, and ends the run
	// without inviting a retry; the end kinds here have no `indeterminate` of their own.
	if (result.status === "indeterminate")
		return finished({ kind: "failed", code: "tool_refused" });
	if (result.status === "needs_approval")
		return finished({
			kind: "stopped",
			code: result.code ?? "approval_required",
			text: "確認が要る操作のため止めました。",
		});
	return {
		state: {
			...current,
			pending: null,
			pendingRaw: null,
			messages: appended(resultMessage(result, callsLeft)),
			known: learn(current.known, result),
		},
		step: { kind: "continue", callsLeft },
	};
}

export const parseCoreState = (value: unknown): CoreState | null =>
	parseArm1State(value);
