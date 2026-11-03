import type { Database } from "bun:sqlite";
import { printable } from "../host/approval.ts";
import type { TrialResult } from "../host/run.ts";
import { aggregateScores } from "../scorer/aggregate.ts";
import { getExperiment, listTrials, type TrialRow } from "../host/store.ts";
import {
	aggregateUsage,
	inferenceLabel,
	trialUsage,
	UNKNOWN_USAGE,
	type UsageRow,
} from "../host/usage.ts";
import { OPERATE_CASE_PREFIX } from "../host/types.ts";

/** `trials`: one line per trial. */
export function trialLines(db: Database, experimentId?: string): string[] {
	return listTrials(db, experimentId === undefined ? {} : { experimentId }).map(
		(t) =>
			[
				t.experimentId,
				t.trialId,
				t.caseId,
				`rep${t.repetition}`,
				t.arm,
				t.state,
				t.runStatus ?? "-",
				t.score === null ? "-" : t.score.success ? "success" : "failure",
			].join("\t"),
	);
}

/** A trial of a case: not an operate run (a free-form request, never judged), and judged or still open. */
const isCaseTrial = (t: TrialRow) =>
	!t.caseId.startsWith(OPERATE_CASE_PREFIX) &&
	(t.score !== null || t.state !== "finished");

/**
 * Tokens, model calls and the estimated cost per platform and inference, overall and per case (plan.md §11).
 * The success rate is over every trial; unknown tokens stay null; cost is an estimate from list prices.
 * A free-form request (no verdict) is not a trial of a case and is left out.
 */
export function usageReport(trials: readonly TrialRow[]) {
	const judged = trials.filter(isCaseTrial);
	const groups = new Map<string, TrialRow[]>();
	for (const t of judged) {
		const key = `${t.platform}\u0000${inferenceLabel(t.inference)}`;
		groups.set(key, [...(groups.get(key) ?? []), t]);
	}
	const input = (t: TrialRow) => ({
		success: t.score?.success === true,
		usage: t.transcript ? trialUsage(t.transcript, t.inference) : UNKNOWN_USAGE,
	});
	return [...groups.entries()].map(([key, rows]) => {
		const [platform, inference] = key.split("\u0000") as [string, string];
		const perCase: Record<string, UsageRow> = {};
		for (const id of [...new Set(rows.map((t) => t.caseId))].sort())
			perCase[id] = aggregateUsage(
				rows.filter((t) => t.caseId === id).map(input),
			);
		return {
			platform,
			inference,
			overall: aggregateUsage(rows.map(input)),
			perCase,
		};
	});
}

/** `report`: the experiment's frozen definition and the aggregate of its scored trials per arm. */
export function report(db: Database, experimentId: string) {
	const experiment = getExperiment(db, experimentId);
	if (!experiment) throw new Error(`experiment_not_found:${experimentId}`);
	const trials = listTrials(db, { experimentId });
	const arms = [...new Set(trials.map((t) => t.arm))].sort();
	return {
		experiment: {
			id: experiment.id,
			caseCount: experiment.caseIds.length,
			repetitions: experiment.repetitions,
			inference: experiment.inferenceKind,
			/** What the experiment was frozen to (model and effort for Claude). */
			inferenceFrozen:
				(experiment.budget as { inference?: unknown }).inference ?? null,
			includesHoldout: experiment.includesHoldout,
		},
		unfinishedTrials: trials.filter((t) => isCaseTrial(t) && t.score === null)
			.length,
		/** Token totals and medians, model calls and the estimated cost (labelled an estimate: list prices). */
		usage: usageReport(trials),
		arms: Object.fromEntries(
			arms.map((arm) => {
				const mine = trials.filter((t) => t.arm === arm && isCaseTrial(t));
				const scores = mine.flatMap((t) => (t.score ? [t.score] : []));
				const aggregate = aggregateScores(scores);
				// The success rate is over ALL trials (plan.md §11): one that never finished is a failure in the
				// denominator, and stays out of the efficiency medians (which `aggregate` takes from scored ones).
				const unfinished = mine.length - scores.length;
				return [
					arm,
					{
						...aggregate,
						trials: mine.length,
						successRate:
							mine.length === 0 ? null : aggregate.successes / mine.length,
						unfinishedCountedAsFailure: unfinished,
					},
				];
			}),
		),
	};
}

/** The URL the browser ended on: the last one it was observed at (the scorer's rule). */
export function finalUrl(result: TrialResult): string | null {
	let url: string | null = null;
	for (const e of result.transcript.events)
		if (e.type === "observation" && e.url !== null) url = e.url;
		else if (e.type === "operation.result" && e.url !== undefined) url = e.url;
	return url;
}

/**
 * What a user wants to see at the end of a run: how it ended, whether it counts as a success, where the
 * browser is and what the model told them. The text is the model's, so it is made safe to print.
 */
export function summaryLines(result: TrialResult): string[] {
	let final: { kind: string; text?: string } | null = null;
	for (const e of result.transcript.events)
		if (e.type === "step.final")
			final = {
				kind: e.kind,
				...(e.text === undefined ? {} : { text: e.text }),
			};
	return [
		`trial\t${result.transcript.caseId}\t${result.status}${result.code ? `(${result.code})` : ""}\t${result.score.success ? "success" : "failure"}`,
		`  final step: ${final?.kind ?? "none"}${final?.text ? ` ${printable(final.text, 300)}` : ""}`,
		`  final url: ${printable(finalUrl(result) ?? "-", 300)}`,
	];
}
