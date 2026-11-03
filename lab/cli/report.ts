import type { Database } from "bun:sqlite";
import { aggregateScores } from "../scorer/aggregate.ts";
import { getExperiment, listTrials } from "../host/store.ts";

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
			includesHoldout: experiment.includesHoldout,
		},
		unfinishedTrials: trials.filter((t) => t.score === null).length,
		arms: Object.fromEntries(
			arms.map((arm) => {
				const mine = trials.filter((t) => t.arm === arm);
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
