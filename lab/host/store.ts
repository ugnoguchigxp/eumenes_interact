import type { Database } from "bun:sqlite";
import type { RunStatus } from "eumenes-interact";
import type { TrialScore } from "../scorer/score.ts";
import type { TrialTranscript } from "../scorer/transcript.ts";
import { write } from "./db.ts";
import type { InferenceInfo, TrialConditions, TrialVersions } from "./types.ts";

/** Typed access to the lab's own tables. Every writer is one committed transaction. */

const LARM_KEYS = ["larm.baseUrl", "larm.profile"] as const;
export type SettingKey = (typeof LARM_KEYS)[number];

export function setSetting(
	db: Database,
	key: SettingKey,
	value: string,
	nowIso: string,
): void {
	write(db, () =>
		db
			.query(
				`INSERT INTO lab_settings (key, value, updated_at) VALUES (?, ?, ?)
				ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.run(key, value, nowIso),
	);
}

export function getSetting(db: Database, key: SettingKey): string | null {
	const row = db
		.query("SELECT value FROM lab_settings WHERE key = ?")
		.get(key) as { value: string } | null;
	return row?.value ?? null;
}

export type ExperimentInput = {
	id: string;
	name: string;
	caseIds: readonly string[];
	caseDigest: string;
	includesHoldout: boolean;
	repetitions: number;
	arms: readonly string[];
	budget: Record<string, unknown>;
	tolerance?: Record<string, unknown>;
	stopRule?: Record<string, unknown>;
	inferenceKind: "scripted" | "larm";
	nowIso: string;
};

export type ExperimentRecord = Omit<ExperimentInput, "nowIso"> & {
	tolerance: Record<string, unknown>;
	stopRule: Record<string, unknown>;
	createdAt: string;
};

export function createExperiment(db: Database, input: ExperimentInput): void {
	write(db, () =>
		db
			.query(
				`INSERT INTO lab_experiments (id, name, created_at, case_ids_json, case_digest, includes_holdout,
					repetitions, arms_json, budget_json, tolerance_json, stop_rule_json, inference_kind)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id,
				input.name,
				input.nowIso,
				JSON.stringify(input.caseIds),
				input.caseDigest,
				input.includesHoldout ? 1 : 0,
				input.repetitions,
				JSON.stringify(input.arms),
				JSON.stringify(input.budget),
				JSON.stringify(input.tolerance ?? {}),
				JSON.stringify(input.stopRule ?? { kind: "none" }),
				input.inferenceKind,
			),
	);
}

export function getExperiment(
	db: Database,
	id: string,
): ExperimentRecord | null {
	const row = db
		.query("SELECT * FROM lab_experiments WHERE id = ?")
		.get(id) as Record<string, string | number> | null;
	if (!row) return null;
	return {
		id: String(row.id),
		name: String(row.name),
		caseIds: JSON.parse(String(row.case_ids_json)),
		caseDigest: String(row.case_digest),
		includesHoldout: row.includes_holdout === 1,
		repetitions: Number(row.repetitions),
		arms: JSON.parse(String(row.arms_json)),
		budget: JSON.parse(String(row.budget_json)),
		tolerance: JSON.parse(String(row.tolerance_json)),
		stopRule: JSON.parse(String(row.stop_rule_json)),
		inferenceKind: row.inference_kind as "scripted" | "larm",
		createdAt: String(row.created_at),
	};
}

export type TrialStart = TrialConditions & {
	trialId: string;
	experimentId: string;
	caseId: string;
	split: "dev" | "holdout";
	repetition: number;
	orderIndex: number;
	runId: string;
	startedAt: string;
	versions: TrialVersions;
	inference: InferenceInfo;
};

export function insertTrial(db: Database, trial: TrialStart): void {
	write(db, () =>
		db
			.query(
				`INSERT INTO lab_trials (trial_id, experiment_id, case_id, split, arm, platform, execution_mode,
					knowledge, repetition, order_index, run_id, started_at, state, versions_json, inference_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
			)
			.run(
				trial.trialId,
				trial.experimentId,
				trial.caseId,
				trial.split,
				trial.arm,
				trial.platform,
				trial.executionMode,
				trial.knowledge,
				trial.repetition,
				trial.orderIndex,
				trial.runId,
				trial.startedAt,
				JSON.stringify(trial.versions),
				JSON.stringify(trial.inference),
			),
	);
}

/** The tool version is only known once the adapter has opened. */
export function updateTrialVersions(
	db: Database,
	trialId: string,
	versions: TrialVersions,
): void {
	write(db, () =>
		db
			.query("UPDATE lab_trials SET versions_json = ? WHERE trial_id = ?")
			.run(JSON.stringify(versions), trialId),
	);
}

export function finishTrial(
	db: Database,
	trialId: string,
	end: {
		runStatus: RunStatus;
		transcript: TrialTranscript;
		score: TrialScore;
		stop: unknown;
		nowIso: string;
		inference: InferenceInfo;
	},
): void {
	write(db, () =>
		db
			.query(
				`UPDATE lab_trials SET state = 'finished', finished_at = ?, run_status = ?, transcript_json = ?,
					score_json = ?, stop_json = ?, inference_json = ? WHERE trial_id = ?`,
			)
			.run(
				end.nowIso,
				end.runStatus,
				JSON.stringify(end.transcript),
				JSON.stringify(end.score),
				end.stop === null ? null : JSON.stringify(end.stop),
				JSON.stringify(end.inference),
				trialId,
			),
	);
}

export type TrialRow = {
	trialId: string;
	experimentId: string;
	caseId: string;
	split: "dev" | "holdout";
	arm: string;
	repetition: number;
	orderIndex: number;
	runId: string;
	state: "running" | "finished" | "interrupted";
	runStatus: RunStatus | null;
	score: TrialScore | null;
	transcript: TrialTranscript | null;
	versions: TrialVersions;
};

export function listTrials(
	db: Database,
	filter: { experimentId?: string } = {},
): TrialRow[] {
	const rows = (
		filter.experimentId === undefined
			? db
					.query("SELECT * FROM lab_trials ORDER BY started_at, order_index")
					.all()
			: db
					.query(
						"SELECT * FROM lab_trials WHERE experiment_id = ? ORDER BY order_index",
					)
					.all(filter.experimentId)
	) as Record<string, string | number | null>[];
	const json = (value: unknown) =>
		typeof value === "string" ? JSON.parse(value) : null;
	return rows.map((row) => ({
		trialId: String(row.trial_id),
		experimentId: String(row.experiment_id),
		caseId: String(row.case_id),
		split: row.split as "dev" | "holdout",
		arm: String(row.arm),
		repetition: Number(row.repetition),
		orderIndex: Number(row.order_index),
		runId: String(row.run_id),
		state: row.state as TrialRow["state"],
		runStatus: row.run_status as RunStatus | null,
		score: json(row.score_json),
		transcript: json(row.transcript_json),
		versions: json(row.versions_json),
	}));
}

export type RoundInput = {
	id: string;
	hypothesis: string;
	changedCondition: string;
	fixedConditions: Record<string, unknown>;
	baselineExperimentId?: string;
	candidateExperimentId?: string;
	nowIso: string;
};

export function createRound(db: Database, input: RoundInput): void {
	write(db, () =>
		db
			.query(
				`INSERT INTO lab_rounds (id, created_at, hypothesis, changed_condition, fixed_conditions_json,
					baseline_experiment_id, candidate_experiment_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id,
				input.nowIso,
				input.hypothesis,
				input.changedCondition,
				JSON.stringify(input.fixedConditions),
				input.baselineExperimentId ?? null,
				input.candidateExperimentId ?? null,
			),
	);
}

export function decideRound(
	db: Database,
	id: string,
	decision: {
		results: unknown;
		decision: "adopt" | "reject" | "measure_more";
		note?: string;
		nowIso: string;
	},
): void {
	write(db, () =>
		db
			.query(
				`UPDATE lab_rounds SET results_json = ?, decision = ?, decision_note = ?, decided_at = ?
				WHERE id = ? AND decision IS NULL`,
			)
			.run(
				JSON.stringify(decision.results),
				decision.decision,
				decision.note ?? null,
				decision.nowIso,
				id,
			),
	);
}
