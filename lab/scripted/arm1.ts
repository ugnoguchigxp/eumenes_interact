import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
	ChatMessage,
	InferencePort,
	PageItem,
	PartName,
} from "eumenes-interact";
import { normalize } from "../aria.ts";

/**
 * A deterministic `InferencePort` for the fixed-response acceptance of Arm 1 (plan.md §6.4, §15 S2b). It
 * writes exactly the part-call JSON a model would, so everything goes through the same `parseStep`. The
 * step it is on is the number of its own outputs already in the messages. An item is named by role, name and
 * region, never by id: the id is looked up in the page summary, candidate list or form the latest results
 * showed (the ids the core accepts). An item it cannot find, or finds twice, becomes an `ask`: it never guesses.
 */

const PARTS: readonly PartName[] = [
	"page.open",
	"page.back",
	"site.search",
	"page.find",
	"item.open",
	"page.wait",
	"page.read",
	"page.list",
	"page.capture",
	"form.inspect",
	"form.fill",
	"form.submit",
];

/** An element as the page names it. Several matches are ambiguous unless `nth` (0-based) says which. */
export const itemTargetSchema = z
	.strictObject({
		role: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		nameAnyOf: z.array(z.string().min(1)).min(1).optional(),
		urlIncludes: z.string().min(1).optional(),
		region: z.string().min(1).optional(),
		nth: z.int().min(0).optional(),
	})
	.refine(
		(t) =>
			t.name !== undefined ||
			t.nameAnyOf !== undefined ||
			t.urlIncludes !== undefined ||
			t.role !== undefined,
		"a target needs a role, a name or a link destination",
	)
	.refine(
		(t) => t.name === undefined || t.nameAnyOf === undefined,
		"give name or nameAnyOf, not both",
	);
export type ItemTarget = z.infer<typeof itemTargetSchema>;

const partStep = z.strictObject({
	part: z.enum(PARTS as [PartName, ...PartName[]]),
	/** The part's arguments except the item ids, which `target` and `fields` stand for. */
	args: z.record(z.string(), z.unknown()).optional(),
	/** The item of `item.open`, `page.read`, `page.capture`, `form.inspect` or `form.submit`. */
	target: itemTargetSchema.optional(),
	/** `form.fill`: each field's item by target, with its value. */
	fields: z
		.array(z.strictObject({ target: itemTargetSchema, value: z.string() }))
		.min(1)
		.optional(),
});
export type PartStep = z.infer<typeof partStep>;

const stepSchema = z.union([
	partStep,
	z.strictObject({
		done: z.string().min(1),
		/** `last`: cite the latest result (default); `none`: cite nothing. */
		evidence: z.enum(["last", "none"]).optional(),
	}),
	z.strictObject({ ask: z.string().min(1) }),
]);
export type Arm1Step = z.infer<typeof stepSchema>;

export const arm1ScriptSchema = z.strictObject({
	caseId: z.string().min(1),
	steps: z.array(stepSchema).min(1),
});
export type Arm1Script = z.infer<typeof arm1ScriptSchema>;

export const ARM1_SCRIPTS_DIR = fileURLToPath(
	new URL("./scripts-arm1", import.meta.url),
);

export const arm1ScriptPath = (caseId: string) =>
	`${ARM1_SCRIPTS_DIR}/${caseId}.json`;

/** The Arm 1 script of a case; a case without one is an error, not a silent skip. */
export async function loadArm1Script(caseId: string): Promise<Arm1Script> {
	let text: string;
	try {
		text = await readFile(arm1ScriptPath(caseId), "utf8");
	} catch {
		throw new Error(`no_script:${caseId}`);
	}
	const script = arm1ScriptSchema.parse(JSON.parse(text));
	if (script.caseId !== caseId)
		throw new Error(`script_case_mismatch:${caseId}`);
	return script;
}

// ---- reading what the core showed

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const pageOf = (item: string) => item.split(".")[0]!;

/** The host-authored data messages (REFERENCE and PART_RESULT), parsed, oldest first. */
function dataMessages(
	messages: readonly ChatMessage[],
): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	messages.forEach((m, index) => {
		if (m.role !== "user") return;
		const mark = m.content.startsWith("PART_RESULT=")
			? "PART_RESULT="
			: index === 1 && m.content.startsWith("REFERENCE=")
				? "REFERENCE="
				: null;
		if (!mark) return;
		try {
			const data: unknown = JSON.parse(m.content.slice(mark.length));
			if (isRecord(data)) out.push(data);
		} catch {
			// Not data the core wrote.
		}
	});
	return out;
}

const asItem = (v: unknown): PageItem | null =>
	isRecord(v) &&
	typeof v.item === "string" &&
	typeof v.role === "string" &&
	typeof v.name === "string"
		? {
				item: v.item,
				role: v.role,
				name: v.name,
				...(typeof v.region === "string" ? { region: v.region } : {}),
				...(typeof v.url === "string" ? { url: v.url } : {}),
			}
		: null;

/** The items one result (or the REFERENCE) names, with what is known of each. */
function itemsOf(data: Record<string, unknown>): PageItem[] {
	const out: PageItem[] = [];
	const push = (v: unknown) => {
		const item = asItem(v);
		if (item) out.push(item);
	};
	const page = isRecord(data.page) ? data.page : null;
	if (page && Array.isArray(page.items)) for (const i of page.items) push(i);
	if (Array.isArray(data.candidates)) for (const i of data.candidates) push(i);
	const list = isRecord(data.list) ? data.list : null;
	if (list && Array.isArray(list.entries))
		for (const e of list.entries)
			if (isRecord(e) && typeof e.item === "string")
				out.push({
					item: e.item,
					role: "link",
					name: typeof e.title === "string" ? e.title : "",
					...(typeof e.url === "string" ? { url: e.url } : {}),
				});
	const form = isRecord(data.form) ? data.form : null;
	if (form) {
		if (Array.isArray(form.fields))
			for (const f of form.fields)
				if (isRecord(f) && typeof f.item === "string")
					out.push({
						item: f.item,
						role: typeof f.kind === "string" ? f.kind : "textbox",
						name: typeof f.label === "string" ? f.label : "",
					});
		if (Array.isArray(form.submit)) for (const i of form.submit) push(i);
	}
	return out;
}

/**
 * The items the AI may name now, by the core's own rule: those of the page the latest result is about
 * (a result about another page starts the set again). Items of one page keep accumulating.
 */
export function knownItems(messages: readonly ChatMessage[]): PageItem[] {
	let page: string | null = null;
	let items = new Map<string, PageItem>();
	for (const data of dataMessages(messages)) {
		const found = itemsOf(data);
		const summary = isRecord(data.page) ? data.page : null;
		const here: string | null =
			summary && typeof summary.page === "string"
				? summary.page
				: found[0]
					? pageOf(found[0].item)
					: page;
		if (here !== page) items = new Map();
		page = here;
		for (const item of found)
			if (pageOf(item.item) === page) items.set(item.item, item);
	}
	return [...items.values()];
}

/** The id of the latest result, for `done`'s evidence. */
const latestResultId = (messages: readonly ChatMessage[]): string | null => {
	for (const data of dataMessages(messages).reverse())
		if (typeof data.resultId === "string") return data.resultId;
	return null;
};

export type Found =
	{ kind: "found"; item: PageItem } | { kind: "none" | "ambiguous" };

/** The item with that role, name, destination and region; several are ambiguous unless `nth` names which. */
export function findItem(
	items: readonly PageItem[],
	target: ItemTarget,
): Found {
	const names =
		target.name !== undefined
			? [normalize(target.name)]
			: (target.nameAnyOf ?? []).map(normalize);
	const hits = items.filter(
		(i) =>
			(target.role === undefined || i.role === target.role) &&
			(names.length === 0 || names.includes(normalize(i.name))) &&
			(target.urlIncludes === undefined ||
				(i.url !== undefined && i.url.includes(target.urlIncludes))) &&
			(target.region === undefined ||
				(i.region !== undefined && i.region.includes(target.region))),
	);
	const pick = target.nth === undefined ? hits[0] : hits[target.nth];
	if (!pick) return { kind: "none" };
	if (target.nth === undefined && hits.length > 1) return { kind: "ambiguous" };
	return { kind: "found", item: pick };
}

const ask = (question: string) =>
	JSON.stringify({ part: "ask", args: { question } });

const label = (t: ItemTarget) =>
	`${t.role ?? ""}「${t.name ?? t.nameAnyOf?.join("/") ?? t.urlIncludes ?? ""}」`;

/** Every argument of the part, as the closed schema wants them (the ones a script leaves out are null). */
const DEFAULTS: Partial<Record<PartName, Record<string, unknown>>> = {
	"page.find": { text: null, role: null },
	"page.wait": { text: null, seconds: null },
	"page.read": { target: null, maxChars: 4000 },
	"page.list": { kind: "results", limit: 10 },
	"page.capture": { range: "viewport", item: null },
	"form.inspect": { form: null },
};

function partOutput(step: PartStep, messages: ChatMessage[]): string {
	const args: Record<string, unknown> = {
		...DEFAULTS[step.part],
		...step.args,
	};
	const items = knownItems(messages);
	const resolve = (target: ItemTarget): string | { ask: string } => {
		const found = findItem(items, target);
		if (found.kind === "found") return found.item.item;
		return {
			ask:
				found.kind === "none"
					? `${label(target)}が見つかりません。`
					: `${label(target)}が複数あり、どれか決められません。`,
		};
	};
	const slot: Partial<Record<PartName, string>> = {
		"item.open": "item",
		"page.read": "target",
		"page.capture": "item",
		"form.inspect": "form",
		"form.submit": "button",
	};
	if (step.target) {
		const key = slot[step.part];
		if (!key) throw new Error(`target_not_for_${step.part}`);
		const id = resolve(step.target);
		if (typeof id !== "string") return ask(id.ask);
		args[key] = id;
	}
	if (step.fields) {
		const fields: { item: string; value: string }[] = [];
		for (const f of step.fields) {
			const id = resolve(f.target);
			if (typeof id !== "string") return ask(id.ask);
			fields.push({ item: id, value: f.value });
		}
		args.fields = fields;
	}
	return JSON.stringify({ part: step.part, args });
}

/** The output of the script's next step for the conversation so far. */
export function nextArm1Output(
	script: Arm1Script,
	messages: ChatMessage[],
): string {
	const step =
		script.steps[messages.filter((m) => m.role === "assistant").length];
	if (!step) return ask("手順を使い切りました。");
	if ("done" in step) {
		const id = step.evidence === "none" ? null : latestResultId(messages);
		return JSON.stringify({
			part: "done",
			args: { answer: step.done, evidence: id ? [id] : [] },
		});
	}
	if ("ask" in step) return ask(step.ask);
	return partOutput(step, messages);
}

export function createArm1ScriptedInference(script: Arm1Script): InferencePort {
	return {
		complete: ({ messages }) =>
			Promise.resolve({
				kind: "text",
				text: nextArm1Output(script, messages),
				// A script reports no usage: unknown, never 0.
				usage: { inputTokens: null, outputTokens: null },
				latencyMs: 0,
			}),
	};
}
