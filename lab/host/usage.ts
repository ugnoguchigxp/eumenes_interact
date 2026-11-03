import { median } from "../scorer/aggregate.ts";
import type { TrialTranscript } from "../scorer/transcript.ts";
import { estimateClaudeCostUsd } from "../inference/index.ts";
import type { InferenceInfo } from "./types.ts";

/**
 * What a trial's model calls took, and what that comes to (plan.md §11 efficiency, §10.5). A token count a
 * provider did not report is null, never 0, and one unknown call makes the trial's sum unknown. Cost is an
 * estimate from list prices (`estimateClaudeCostUsd`), per call (the price depends on the prompt's size),
 * known only for a Claude run whose every call reported its tokens.
 */

export type TrialUsage = {
	/** Claude's `input` is the uncached part of the prompt only; compare providers by `promptTotal`. */
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	/** Input plus cache reads and writes; an unreported cache counter counts as no cache use. */
	promptTotal: number | null;
	/** Null when unknown (a trial that left no transcript). */
	modelCalls: number | null;
	costUsd: number | null;
};

/** What a trial that made no model call used: nothing, and so it cost nothing when the price is known. */
export const noCalls = (priced: boolean): TrialUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	promptTotal: 0,
	modelCalls: 0,
	costUsd: priced ? 0 : null,
});

/** A trial that left no transcript used an unknown amount. */
export const UNKNOWN_USAGE: TrialUsage = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	promptTotal: null,
	modelCalls: null,
	costUsd: null,
};

/** The sum, or null when any item is unknown. */
const sumKnown = (values: readonly (number | null | undefined)[]) => {
	let total = 0;
	for (const v of values) {
		if (v === null || v === undefined) return null;
		total += v;
	}
	return total;
};

export function trialUsage(
	transcript: TrialTranscript,
	inference: InferenceInfo | null,
): TrialUsage {
	const calls = transcript.events.flatMap((e) =>
		e.type === "model.call" ? [e.tokens] : [],
	);
	const costs =
		inference?.kind === "claude"
			? calls.map((t) =>
					estimateClaudeCostUsd(inference.model, {
						inputTokens: t.input,
						outputTokens: t.output,
						cacheReadInputTokens: t.cacheRead ?? null,
						cacheCreationInputTokens: t.cacheWrite ?? null,
					}),
				)
			: null;
	return {
		input: sumKnown(calls.map((t) => t.input)),
		output: sumKnown(calls.map((t) => t.output)),
		cacheRead: sumKnown(calls.map((t) => t.cacheRead)),
		cacheWrite: sumKnown(calls.map((t) => t.cacheWrite)),
		promptTotal: sumKnown(
			calls.map((t) =>
				t.input === null
					? null
					: t.input + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0),
			),
		),
		modelCalls: calls.length,
		costUsd: costs === null ? null : sumKnown(costs),
	};
}

/** The label that groups trials by what answered them. */
export function inferenceLabel(info: InferenceInfo | null | undefined): string {
	if (!info) return "unknown";
	switch (info.kind) {
		case "scripted":
			return "scripted";
		case "larm":
			return `larm:${info.profile}`;
		case "claude":
			return `claude:${info.model}/${info.effort}`;
	}
}

export type UsageStat = {
	/** Over all trials; null when any trial's value is unknown. */
	total: number | null;
	/** Over the completed trials whose value is known; null when none is. */
	median: number | null;
};

export type UsageRow = {
	trials: number;
	successes: number;
	/** Over ALL trials. */
	successRate: number | null;
	modelCalls: UsageStat;
	tokens: {
		/** Uncached input for Claude (the cache is counted apart). */
		input: UsageStat;
		output: UsageStat;
		cacheRead: UsageStat;
		cacheWrite: UsageStat;
		/** Input plus cache reads and writes: the whole prompt, comparable across providers. */
		promptTotal: UsageStat;
	};
	/** An estimate from list prices, not a bill. Null while any trial's cost is unknown. */
	costUsdEstimate: {
		total: number | null;
		perTrial: number | null;
		/** Everything spent (failures included) over the trials that worked. */
		perSuccess: number | null;
	};
};

export type UsageInput = { success: boolean; usage: TrialUsage };

export function aggregateUsage(items: readonly UsageInput[]): UsageRow {
	const completed = items.filter((i) => i.success);
	const stat = (pick: (u: TrialUsage) => number | null): UsageStat => ({
		total: sumKnown(items.map((i) => pick(i.usage))),
		median: median(
			completed.flatMap((i) => {
				const v = pick(i.usage);
				return v === null ? [] : [v];
			}),
		),
	});
	const cost = sumKnown(items.map((i) => i.usage.costUsd));
	return {
		trials: items.length,
		successes: completed.length,
		successRate: items.length === 0 ? null : completed.length / items.length,
		modelCalls: stat((u) => u.modelCalls),
		tokens: {
			input: stat((u) => u.input),
			output: stat((u) => u.output),
			cacheRead: stat((u) => u.cacheRead),
			cacheWrite: stat((u) => u.cacheWrite),
			promptTotal: stat((u) => u.promptTotal),
		},
		costUsdEstimate: {
			total: items.length === 0 ? null : cost,
			perTrial:
				cost === null || items.length === 0 ? null : cost / items.length,
			perSuccess:
				cost === null || completed.length === 0
					? null
					: cost / completed.length,
		},
	};
}
