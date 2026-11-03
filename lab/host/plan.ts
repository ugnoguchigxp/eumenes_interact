import { createHash } from "node:crypto";
import type { ArmId } from "eumenes-interact";
import type { CaseDef } from "../cases/schema.ts";

/**
 * Which cases a run may use, and in what order the trials go. Holdout cases are for the take-back decision
 * only (plan.md §10.2): they load only when the caller says so, on top of `loadCases`' own flag.
 */

export type Selection = {
	caseId?: string;
	split?: "dev" | "holdout";
	includeHoldout: boolean;
};

/** The cases a selection names. A holdout case without `includeHoldout` is refused, never skipped quietly. */
export function selectCases(
	all: readonly CaseDef[],
	selection: Selection,
): CaseDef[] {
	if (selection.caseId === undefined && selection.split === undefined)
		throw new Error("select_case_or_split");
	if (selection.split === "holdout" && !selection.includeHoldout)
		throw new Error("holdout_needs_include_holdout");
	const chosen = all.filter((c) =>
		selection.caseId !== undefined
			? c.id === selection.caseId
			: c.split === selection.split,
	);
	if (chosen.length === 0)
		throw new Error(
			selection.caseId !== undefined
				? `case_not_found:${selection.caseId}`
				: "no_cases",
		);
	if (!selection.includeHoldout && chosen.some((c) => c.split === "holdout"))
		throw new Error("holdout_needs_include_holdout");
	return chosen;
}

export type PlannedTrial = {
	def: CaseDef;
	arm: ArmId;
	repetition: number;
	orderIndex: number;
};

/**
 * The trial order (plan.md §10.4): repetitions in turn, cases in order within a repetition, and the arms
 * rotated per (repetition, case) so no arm always goes first. With one arm it is cases times repetitions.
 */
export function planTrials(
	cases: readonly CaseDef[],
	arms: readonly ArmId[],
	repetitions: number,
): PlannedTrial[] {
	const trials: PlannedTrial[] = [];
	for (let repetition = 1; repetition <= repetitions; repetition++)
		cases.forEach((def, caseIndex) => {
			for (let k = 0; k < arms.length; k++) {
				const arm = arms[(repetition - 1 + caseIndex + k) % arms.length]!;
				trials.push({ def, arm, repetition, orderIndex: trials.length });
			}
		});
	return trials;
}

/** Digest of the case definitions an experiment froze, so a case edited afterwards is visible. */
export const caseDigest = (cases: readonly CaseDef[]) =>
	createHash("sha256").update(JSON.stringify(cases)).digest("hex");
