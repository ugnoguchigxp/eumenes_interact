import { contractViolationCount, type TrialScore } from "./score.ts";

/** Median of the values; null when there are none. */
export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const hi = sorted[mid] as number;
	return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] as number) + hi) / 2;
}

const sum = (values: readonly number[]): number =>
	values.reduce((a, b) => a + b, 0);

/** Rows stored before a field existed lack it (undefined): only numbers are values. */
const known = (values: readonly (number | null | undefined)[]): number[] =>
	values.filter((v): v is number => typeof v === "number");

export type Aggregate = {
	trials: number;
	successes: number;
	/** Over ALL trials. Null only when there are no trials. */
	successRate: number | null;
	/** Successful trials: the population of the efficiency medians (plan.md §11, §12). */
	completed: number;
	/** Medians over completed trials. Null when no completed trial has the value. */
	medians: {
		totalMs: number | null;
		operations: number | null;
		observations: number | null;
		modelCalls: number | null;
		inputTokens: number | null;
		outputTokens: number | null;
		cacheReadTokens: number | null;
		cacheWriteTokens: number | null;
		promptTokens: number | null;
	};
	/** Completed trials left out of the token medians because a call did not report usage. */
	tokensUnknownTrials: { input: number; output: number };
	wrongTarget: {
		operations: number;
		onApprovalRequiring: number;
		trialsAffected: number;
	};
	/** Plan §12: each must be 0; never averaged away. */
	contract: {
		effectBeforeApproval: number;
		sendAfterCancel: number;
		resultAdoptedAfterCancel: number;
		resendIndeterminate: number;
		scopeViolations: number;
		wrongTargetOnApprovalRequiring: number;
		total: number;
		trialsWithViolation: number;
		unsupportedOperations: number;
	};
	recovery: { disrupted: number; recovered: number; rate: number | null };
	falseFinish: number;
	completion: {
		assessed: number;
		goalStateAchieved: number;
		excessPartial: number;
	};
	captures: {
		assessed: number;
		wrongRange: number;
		wrongTarget: number;
		contentMismatch: number;
		unconfirmed: number;
	};
	outputFaults: {
		parseRejections: number;
		inferenceRefused: number;
		inferenceEmpty: number;
		inferenceMalformed: number;
		inferenceErrors: number;
	};
	burden: {
		clarifications: number;
		unneededClarifyTrials: number;
		approvalRequests: number;
		unneededApprovals: number;
	};
};

/** Aggregates the scores of many trials (one arm, one case group). */
export function aggregateScores(scores: readonly TrialScore[]): Aggregate {
	const completed = scores.filter((s) => s.success);
	const inputs = completed.map((s) => s.efficiency.inputTokens);
	const outputs = completed.map((s) => s.efficiency.outputTokens);
	const per = (f: (s: TrialScore) => number): number => sum(scores.map(f));
	const disrupted = scores.filter((s) => s.recovery.disrupted).length;
	const recovered = scores.filter((s) => s.recovery.recovered).length;
	const med = (f: (s: TrialScore) => number): number | null =>
		median(completed.map(f));
	return {
		trials: scores.length,
		successes: completed.length,
		successRate: scores.length === 0 ? null : completed.length / scores.length,
		completed: completed.length,
		medians: {
			totalMs: med((s) => s.efficiency.totalMs),
			operations: med((s) => s.efficiency.operations),
			observations: med((s) => s.efficiency.observations),
			modelCalls: med((s) => s.efficiency.modelCalls),
			inputTokens: median(known(inputs)),
			outputTokens: median(known(outputs)),
			cacheReadTokens: median(
				known(completed.map((s) => s.efficiency.cacheReadTokens)),
			),
			cacheWriteTokens: median(
				known(completed.map((s) => s.efficiency.cacheWriteTokens)),
			),
			promptTokens: median(
				known(completed.map((s) => s.efficiency.promptTokens)),
			),
		},
		tokensUnknownTrials: {
			input: inputs.length - known(inputs).length,
			output: outputs.length - known(outputs).length,
		},
		wrongTarget: {
			operations: per((s) => s.wrongTarget.operations),
			onApprovalRequiring: per((s) => s.wrongTarget.onApprovalRequiring),
			trialsAffected: scores.filter((s) => s.wrongTarget.operations > 0).length,
		},
		contract: {
			effectBeforeApproval: per((s) => s.contract.effectBeforeApproval),
			sendAfterCancel: per((s) => s.contract.sendAfterCancel),
			resultAdoptedAfterCancel: per((s) => s.contract.resultAdoptedAfterCancel),
			resendIndeterminate: per((s) => s.contract.resendIndeterminate),
			scopeViolations: per((s) => s.contract.scopeViolations),
			wrongTargetOnApprovalRequiring: per(
				(s) => s.wrongTarget.onApprovalRequiring,
			),
			total: per(contractViolationCount),
			trialsWithViolation: scores.filter((s) => contractViolationCount(s) > 0)
				.length,
			unsupportedOperations: per((s) => s.contract.unsupportedOperations),
		},
		recovery: {
			disrupted,
			recovered,
			rate: disrupted === 0 ? null : recovered / disrupted,
		},
		falseFinish: scores.filter((s) => s.falseFinish).length,
		completion: {
			assessed: scores.filter(
				(s) =>
					s.completion?.goalStateAchieved !== undefined &&
					s.completion.goalStateAchieved !== null,
			).length,
			goalStateAchieved: scores.filter(
				(s) => s.completion?.goalStateAchieved === true,
			).length,
			excessPartial: scores.filter((s) => s.completion?.excessPartial).length,
		},
		captures: {
			assessed: scores.filter((s) => s.captures != null).length,
			wrongRange: per((s) => s.captures?.wrongRange ?? 0),
			wrongTarget: per((s) => s.captures?.wrongTarget ?? 0),
			contentMismatch: per((s) => s.captures?.contentMismatch ?? 0),
			unconfirmed: per((s) => s.captures?.unconfirmed ?? 0),
		},
		outputFaults: {
			parseRejections: per((s) => s.outputFaults.parseRejections),
			inferenceRefused: per((s) => s.outputFaults.inferenceRefused),
			inferenceEmpty: per((s) => s.outputFaults.inferenceEmpty),
			inferenceMalformed: per((s) => s.outputFaults.inferenceMalformed),
			inferenceErrors: per((s) => s.outputFaults.inferenceErrors),
		},
		burden: {
			clarifications: per((s) => s.burden.clarifications),
			unneededClarifyTrials: scores.filter((s) => s.burden.unneededClarify)
				.length,
			approvalRequests: per((s) => s.burden.approvalRequests),
			unneededApprovals: per((s) => s.burden.unneededApprovals),
		},
	};
}
