import type {
	FormField,
	InputProvenance,
	ObservationEnvelope,
	PartResult,
} from "../../../index.ts";
import { assertValueQuoted, choiceSourced } from "../../source.ts";
import {
	batch,
	elementName,
	observationAfter,
	observeFresh,
	operate,
	PartFail,
	resolve,
	summarize,
	type Body,
	type ExecutorContext,
	type Target,
} from "./context.ts";
import { click } from "./item.ts";

/**
 * What a model may write for a checkbox or a radio button (the system text asks for on or off). Any other value
 * is refused for the model to restate: a passage such as 「不要」 is never read as a choice.
 */
const ON_WORDS = new Set([
	"on",
	"true",
	"yes",
	"1",
	"checked",
	"オン",
	"はい",
	"する",
	"あり",
]);
const OFF_WORDS = new Set([
	"off",
	"false",
	"no",
	"0",
	"unchecked",
	"オフ",
	"いいえ",
	"しない",
	"なし",
]);
const sameKey = (text: string) => text.normalize("NFKC").trim().toLowerCase();

/** Fields a person types into; a combobox with options is chosen from instead. */
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

const sameText = (a: string, b: string) =>
	a.normalize("NFKC").trim().toLowerCase() ===
	b.normalize("NFKC").trim().toLowerCase();

export async function formInspect(
	ctx: ExecutorContext,
	formId: string | null,
): Promise<Body> {
	const observation = await observeFresh(ctx);
	const form =
		formId === null ? null : resolve(ctx, formId, observation).record;
	const found = batch(ctx, observation, (pageId) =>
		ctx.core.formFields(observation.body, pageId, form),
	);
	return {
		status: "completed",
		form: { fields: found.fields, submit: found.submit },
	};
}

/** What the field is, as the helpers describe it (every field of the page), matched to the element by its ref. */
function fieldOf(
	ctx: ExecutorContext,
	observation: ObservationEnvelope,
	ref: string,
): FormField | undefined {
	const found = ctx.core.formFields(observation.body, "p0", "page");
	const record = found.records.find((r) => r.ref === ref);
	return record ? found.fields.find((f) => f.item === record.item) : undefined;
}

/** Where a typed value comes from: a passage of the request, or a value the user approved for this site. */
function provenanceOf(
	ctx: ExecutorContext,
	value: string,
	pageUrl: string,
	quote?: string | null,
): InputProvenance | null {
	if (quote != null) {
		try {
			// The passage must hold the value; separators may differ (source.ts), as for a value quoted by itself.
			assertValueQuoted(value, quote, ctx.deps.request);
			return { kind: "request_quote", quote };
		} catch {
			return null;
		}
	}
	try {
		assertValueQuoted(value, value, ctx.deps.request);
		return { kind: "request_quote", quote: value };
	} catch {
		// Not a passage of the request.
	}
	const ref = ctx.grants.find(value, pageUrl);
	return ref === null ? null : { kind: "grant", inputValueRef: ref };
}

type FillResult = NonNullable<PartResult["fill"]>[number];

async function fillOne(
	ctx: ExecutorContext,
	field: { item: string; value: string; quote?: string | null },
	observation: ObservationEnvelope,
): Promise<{
	result: FillResult;
	observation: ObservationEnvelope | null;
	stop?: string;
}> {
	const refused = (code: string): FillResult => ({
		item: field.item,
		status: "refused",
		code,
	});
	let target: Target;
	try {
		target = resolve(ctx, field.item, observation);
	} catch (error) {
		if (error instanceof PartFail)
			return { result: refused(error.code), observation };
		throw error;
	}
	const info = fieldOf(ctx, observation, target.ref);
	const options = info?.options ?? [];
	const kind = info?.kind ?? target.record.role;
	const filled = (): {
		result: FillResult;
		observation: ObservationEnvelope;
	} => ({
		result: { item: field.item, status: "filled" },
		observation,
	});
	const needsInput = () => ({
		result: {
			item: field.item,
			status: "needs_input" as const,
			code: "value_source",
		},
		observation,
	});
	const element = elementName(target.record);
	/** Whether the request makes this choice (source.ts): an option may also be named by the model's value. */
	const choiceSource = (label: string, value?: string) =>
		choiceSourced(label, ctx.deps.request, {
			quote: field.quote,
			...(value === undefined ? {} : { value }),
		});
	let command: Parameters<typeof operate>[1];
	let provenance: InputProvenance | undefined;
	if (options.length > 0) {
		// The option is the page's; the choice must be the user's. The value may be the request's own words for
		// it (「11月21日」 for 「11月21日（土）」): the one option that contains them is chosen, never one of several.
		const exact = options.find((o) => sameText(o, field.value));
		const wanted = sameKey(field.value);
		const containing =
			wanted === "" ? [] : options.filter((o) => sameKey(o).includes(wanted));
		const option =
			exact ?? (containing.length === 1 ? containing[0] : undefined);
		if (option === undefined)
			return {
				result: refused(
					containing.length > 1 ? "option_ambiguous" : "option_not_found",
				),
				observation,
			};
		if (!choiceSource(option, field.value)) return needsInput();
		command = {
			action: "page.select",
			targetRef: target.ref,
			element,
			values: [option],
		};
	} else if (kind === "checkbox" || kind === "radio") {
		// A choice is made (or undone) by clicking, from its current state. The value is on or off; anything
		// else is the model's to restate. Choosing needs the request to mention the choice; clearing a box only
		// removes something, so it needs none.
		const word = sameKey(field.value);
		const on = ON_WORDS.has(word);
		if (!on && !OFF_WORDS.has(word))
			return { result: refused("choice_value"), observation };
		if (info === undefined)
			return { result: refused("field_unknown"), observation };
		if (!on) {
			if (kind === "radio")
				return { result: refused("cannot_uncheck"), observation };
			if (!info.filled) return filled();
		} else {
			if (!choiceSource(info.label || target.record.name)) return needsInput();
			if (info.filled) return filled();
		}
		command = { action: "page.click", targetRef: target.ref, element };
	} else if (TEXT_ROLES.has(target.record.role)) {
		const found = provenanceOf(
			ctx,
			field.value,
			observation.url ?? "",
			field.quote,
		);
		if (found === null) return needsInput();
		provenance = found;
		command = {
			action: "page.fill",
			targetRef: target.ref,
			element,
			text: field.value,
			submit: false,
		};
	} else return { result: refused("unsupported_field"), observation };
	const s = await operate(ctx, command, "input", {
		observation,
		...(provenance ? { inputProvenance: provenance } : {}),
	});
	if (s.kind === "refused") return { result: refused(s.code), observation };
	if (s.kind !== "operation")
		return { result: refused("unexpected_outcome"), observation };
	if (s.result.status !== "confirmed")
		return {
			result: refused(s.result.code ?? "operation_failed"),
			observation,
		};
	try {
		return {
			result: { item: field.item, status: "filled" },
			observation: await observationAfter(ctx, s),
		};
	} catch (error) {
		// The value reached the page; only the look after it failed. The fill stops here, as partial.
		if (error instanceof PartFail)
			return {
				result: { item: field.item, status: "filled" },
				observation: null,
				stop: error.code,
			};
		throw error;
	}
}

export async function formFill(
	ctx: ExecutorContext,
	fields: { item: string; value: string; quote?: string | null }[],
): Promise<Body> {
	let observation = await observeFresh(ctx);
	const fill: FillResult[] = [];
	for (const field of fields) {
		const done = await fillOne(ctx, field, observation);
		fill.push(done.result);
		if (done.observation === null)
			return {
				status: "partial",
				code: done.stop ?? "observation_unavailable",
				fill,
			};
		observation = done.observation;
	}
	const filled = fill.filter((f) => f.status === "filled").length;
	const first = fill.find((f) => f.status !== "filled");
	return {
		status:
			filled === fill.length ? "completed" : filled > 0 ? "partial" : "failed",
		...(first?.code === undefined ? {} : { code: first.code }),
		fill,
	};
}

export async function formSubmit(
	ctx: ExecutorContext,
	buttonId: string,
): Promise<Body> {
	const observation = await observeFresh(ctx);
	const target = resolve(ctx, buttonId, observation);
	// A submission always asks first (the declared effect): nothing is sent until the user allows it.
	const after = await click(ctx, target, observation, "submit");
	return { status: "completed", page: summarize(ctx, after) };
}
