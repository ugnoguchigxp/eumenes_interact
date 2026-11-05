/**
 * The lab's own migrations (plan.md §3.3): experiment tables never go into the package. Ordered, append-only
 * SQL strings; ids are `lab/NNNN` by position. The tables reference the package's `interact_runs`, so they
 * are applied after the package migrations. Settings never hold tokens (plan.md §10.5): the token comes from
 * the environment on every call.
 */
const labTables = `
CREATE TABLE lab_settings (
	key TEXT PRIMARY KEY CHECK (key IN ('larm.baseUrl', 'larm.profile')),
	value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 2048),
	updated_at TEXT NOT NULL
);

-- What a set of trials was frozen to before it ran (plan.md §10.4).
CREATE TABLE lab_experiments (
	id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
	name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	case_ids_json TEXT NOT NULL CHECK (json_valid(case_ids_json) AND json_type(case_ids_json) = 'array'),
	-- sha256 of the case definitions at freeze time: a case edited later is visible.
	case_digest TEXT NOT NULL,
	includes_holdout INTEGER NOT NULL CHECK (includes_holdout IN (0, 1)),
	repetitions INTEGER NOT NULL CHECK (repetitions >= 1),
	arms_json TEXT NOT NULL CHECK (json_valid(arms_json) AND json_type(arms_json) = 'array'),
	budget_json TEXT NOT NULL CHECK (json_valid(budget_json) AND json_type(budget_json) = 'object'),
	tolerance_json TEXT NOT NULL CHECK (json_valid(tolerance_json) AND json_type(tolerance_json) = 'object'),
	stop_rule_json TEXT NOT NULL CHECK (json_valid(stop_rule_json) AND json_type(stop_rule_json) = 'object'),
	inference_kind TEXT NOT NULL CHECK (inference_kind IN ('scripted', 'larm'))
);

CREATE TABLE lab_trials (
	trial_id TEXT PRIMARY KEY,
	experiment_id TEXT NOT NULL REFERENCES lab_experiments (id),
	case_id TEXT NOT NULL,
	split TEXT NOT NULL CHECK (split IN ('dev', 'holdout')),
	-- Conditions (plan.md §10.3). Only Arm 0's values exist today; the CHECKs keep a stray value out.
	arm TEXT NOT NULL CHECK (arm IN ('arm0')),
	platform TEXT NOT NULL,
	execution_mode TEXT NOT NULL CHECK (execution_mode = 'free'),
	knowledge TEXT NOT NULL CHECK (knowledge = 'none'),
	repetition INTEGER NOT NULL CHECK (repetition >= 1),
	order_index INTEGER NOT NULL CHECK (order_index >= 0),
	run_id TEXT NOT NULL REFERENCES interact_runs (run_id),
	started_at TEXT NOT NULL,
	finished_at TEXT,
	-- running until the host writes the end; interrupted when a restart finds it unfinished.
	state TEXT NOT NULL CHECK (state IN ('running', 'finished', 'interrupted')),
	run_status TEXT,
	versions_json TEXT NOT NULL CHECK (json_valid(versions_json)),
	inference_json TEXT NOT NULL CHECK (json_valid(inference_json)),
	transcript_json TEXT CHECK (transcript_json IS NULL OR json_valid(transcript_json)),
	score_json TEXT CHECK (score_json IS NULL OR json_valid(score_json)),
	-- The approvals a run that ended as needs_input asks the user for.
	stop_json TEXT CHECK (stop_json IS NULL OR json_valid(stop_json)),
	UNIQUE (experiment_id, case_id, arm, repetition)
);
CREATE INDEX lab_trials_by_experiment ON lab_trials (experiment_id, order_index);

-- One change per round (plan.md §10.1).
CREATE TABLE lab_rounds (
	id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
	created_at TEXT NOT NULL,
	hypothesis TEXT NOT NULL CHECK (length(hypothesis) > 0),
	changed_condition TEXT NOT NULL CHECK (length(changed_condition) > 0),
	fixed_conditions_json TEXT NOT NULL CHECK (json_valid(fixed_conditions_json)),
	baseline_experiment_id TEXT REFERENCES lab_experiments (id),
	candidate_experiment_id TEXT REFERENCES lab_experiments (id),
	results_json TEXT CHECK (results_json IS NULL OR json_valid(results_json)),
	decision TEXT CHECK (decision IS NULL OR decision IN ('adopt', 'reject', 'measure_more')),
	decision_note TEXT,
	decided_at TEXT
);
`;

/**
 * Live cases (plan.md §10.2) are a third split. SQLite cannot change a CHECK, so `lab_trials` is rebuilt
 * with the wider one (nothing references it); experiments learn whether they included live cases.
 */
const liveSplit = `
ALTER TABLE lab_experiments
	ADD COLUMN includes_live INTEGER NOT NULL DEFAULT 0 CHECK (includes_live IN (0, 1));

CREATE TABLE lab_trials_next (
	trial_id TEXT PRIMARY KEY,
	experiment_id TEXT NOT NULL REFERENCES lab_experiments (id),
	case_id TEXT NOT NULL,
	split TEXT NOT NULL CHECK (split IN ('dev', 'holdout', 'live')),
	arm TEXT NOT NULL CHECK (arm IN ('arm0')),
	platform TEXT NOT NULL,
	execution_mode TEXT NOT NULL CHECK (execution_mode = 'free'),
	knowledge TEXT NOT NULL CHECK (knowledge = 'none'),
	repetition INTEGER NOT NULL CHECK (repetition >= 1),
	order_index INTEGER NOT NULL CHECK (order_index >= 0),
	run_id TEXT NOT NULL REFERENCES interact_runs (run_id),
	started_at TEXT NOT NULL,
	finished_at TEXT,
	state TEXT NOT NULL CHECK (state IN ('running', 'finished', 'interrupted')),
	run_status TEXT,
	versions_json TEXT NOT NULL CHECK (json_valid(versions_json)),
	inference_json TEXT NOT NULL CHECK (json_valid(inference_json)),
	transcript_json TEXT CHECK (transcript_json IS NULL OR json_valid(transcript_json)),
	score_json TEXT CHECK (score_json IS NULL OR json_valid(score_json)),
	stop_json TEXT CHECK (stop_json IS NULL OR json_valid(stop_json)),
	UNIQUE (experiment_id, case_id, arm, repetition)
);
INSERT INTO lab_trials_next SELECT trial_id, experiment_id, case_id, split, arm, platform, execution_mode,
	knowledge, repetition, order_index, run_id, started_at, finished_at, state, run_status, versions_json,
	inference_json, transcript_json, score_json, stop_json FROM lab_trials;
DROP TABLE lab_trials;
ALTER TABLE lab_trials_next RENAME TO lab_trials;
CREATE INDEX lab_trials_by_experiment ON lab_trials (experiment_id, order_index);
`;

/**
 * Runs of work definitions (plan.md §6). The run itself is an `interact_runs` row; this adds what the lab
 * knows about it. The inputs are never stored, only a digest of them (plan.md §14).
 */
const definitionRuns = `
CREATE TABLE lab_definition_runs (
	run_id TEXT PRIMARY KEY REFERENCES interact_runs (run_id),
	definition_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision >= 1),
	definition_digest TEXT NOT NULL,
	inputs_sha256 TEXT NOT NULL CHECK (length(inputs_sha256) = 64),
	started_at TEXT NOT NULL,
	finished_at TEXT,
	status TEXT,
	-- Step statuses and the final URL: no extracted text, no observation, no input.
	summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json))
);
`;

/** Which platform and external tool a definition run used (plan.md §10.3, §14). */
const definitionPlatform = `
ALTER TABLE lab_definition_runs ADD COLUMN platform TEXT;
ALTER TABLE lab_definition_runs
	ADD COLUMN tool_json TEXT CHECK (tool_json IS NULL OR json_valid(tool_json));
`;

/**
 * A third inference: the Claude API. The CHECK of `lab_experiments.inference_kind` is widened by rebuilding
 * the table (other tables point at it, so the host applies lab migrations with foreign keys off and checks
 * them afterwards).
 */
const claudeInference = `
CREATE TABLE lab_experiments_next (
	id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
	name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	case_ids_json TEXT NOT NULL CHECK (json_valid(case_ids_json) AND json_type(case_ids_json) = 'array'),
	case_digest TEXT NOT NULL,
	includes_holdout INTEGER NOT NULL CHECK (includes_holdout IN (0, 1)),
	repetitions INTEGER NOT NULL CHECK (repetitions >= 1),
	arms_json TEXT NOT NULL CHECK (json_valid(arms_json) AND json_type(arms_json) = 'array'),
	budget_json TEXT NOT NULL CHECK (json_valid(budget_json) AND json_type(budget_json) = 'object'),
	tolerance_json TEXT NOT NULL CHECK (json_valid(tolerance_json) AND json_type(tolerance_json) = 'object'),
	stop_rule_json TEXT NOT NULL CHECK (json_valid(stop_rule_json) AND json_type(stop_rule_json) = 'object'),
	inference_kind TEXT NOT NULL CHECK (inference_kind IN ('scripted', 'larm', 'claude')),
	includes_live INTEGER NOT NULL DEFAULT 0 CHECK (includes_live IN (0, 1))
);
INSERT INTO lab_experiments_next (id, name, created_at, case_ids_json, case_digest, includes_holdout,
	repetitions, arms_json, budget_json, tolerance_json, stop_rule_json, inference_kind, includes_live)
	SELECT id, name, created_at, case_ids_json, case_digest, includes_holdout, repetitions, arms_json,
	budget_json, tolerance_json, stop_rule_json, inference_kind, includes_live FROM lab_experiments;
DROP TABLE lab_experiments;
ALTER TABLE lab_experiments_next RENAME TO lab_experiments;
`;

/**
 * A second arm: registered parts (plan.md §6.4). The CHECK on `lab_trials.arm` is widened by rebuilding the
 * table (nothing references it; the experiments already keep their arms as a list).
 */
const partsArm = `
CREATE TABLE lab_trials_next (
	trial_id TEXT PRIMARY KEY,
	experiment_id TEXT NOT NULL REFERENCES lab_experiments (id),
	case_id TEXT NOT NULL,
	split TEXT NOT NULL CHECK (split IN ('dev', 'holdout', 'live')),
	arm TEXT NOT NULL CHECK (arm IN ('arm0', 'arm1')),
	platform TEXT NOT NULL,
	execution_mode TEXT NOT NULL CHECK (execution_mode = 'free'),
	knowledge TEXT NOT NULL CHECK (knowledge = 'none'),
	repetition INTEGER NOT NULL CHECK (repetition >= 1),
	order_index INTEGER NOT NULL CHECK (order_index >= 0),
	run_id TEXT NOT NULL REFERENCES interact_runs (run_id),
	started_at TEXT NOT NULL,
	finished_at TEXT,
	state TEXT NOT NULL CHECK (state IN ('running', 'finished', 'interrupted')),
	run_status TEXT,
	versions_json TEXT NOT NULL CHECK (json_valid(versions_json)),
	inference_json TEXT NOT NULL CHECK (json_valid(inference_json)),
	transcript_json TEXT CHECK (transcript_json IS NULL OR json_valid(transcript_json)),
	score_json TEXT CHECK (score_json IS NULL OR json_valid(score_json)),
	stop_json TEXT CHECK (stop_json IS NULL OR json_valid(stop_json)),
	UNIQUE (experiment_id, case_id, arm, repetition)
);
INSERT INTO lab_trials_next SELECT trial_id, experiment_id, case_id, split, arm, platform, execution_mode,
	knowledge, repetition, order_index, run_id, started_at, finished_at, state, run_status, versions_json,
	inference_json, transcript_json, score_json, stop_json FROM lab_trials;
DROP TABLE lab_trials;
ALTER TABLE lab_trials_next RENAME TO lab_trials;
CREATE INDEX lab_trials_by_experiment ON lab_trials (experiment_id, order_index);
`;

/** Add the OpenAI provider without changing previously applied migration bodies. */
const openAIInference = `
CREATE TABLE lab_experiments_next (
	id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
	name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	case_ids_json TEXT NOT NULL CHECK (json_valid(case_ids_json) AND json_type(case_ids_json) = 'array'),
	case_digest TEXT NOT NULL,
	includes_holdout INTEGER NOT NULL CHECK (includes_holdout IN (0, 1)),
	repetitions INTEGER NOT NULL CHECK (repetitions >= 1),
	arms_json TEXT NOT NULL CHECK (json_valid(arms_json) AND json_type(arms_json) = 'array'),
	budget_json TEXT NOT NULL CHECK (json_valid(budget_json) AND json_type(budget_json) = 'object'),
	tolerance_json TEXT NOT NULL CHECK (json_valid(tolerance_json) AND json_type(tolerance_json) = 'object'),
	stop_rule_json TEXT NOT NULL CHECK (json_valid(stop_rule_json) AND json_type(stop_rule_json) = 'object'),
	inference_kind TEXT NOT NULL CHECK (inference_kind IN ('scripted', 'larm', 'claude', 'openai')),
	includes_live INTEGER NOT NULL DEFAULT 0 CHECK (includes_live IN (0, 1))
);
INSERT INTO lab_experiments_next (id, name, created_at, case_ids_json, case_digest, includes_holdout,
	repetitions, arms_json, budget_json, tolerance_json, stop_rule_json, inference_kind, includes_live)
	SELECT id, name, created_at, case_ids_json, case_digest, includes_holdout, repetitions, arms_json,
	budget_json, tolerance_json, stop_rule_json, inference_kind, includes_live FROM lab_experiments;
DROP TABLE lab_experiments;
ALTER TABLE lab_experiments_next RENAME TO lab_experiments;
`;

export const labMigrations: readonly string[] = Object.freeze([
	labTables.trim() + "\n",
	liveSplit.trim() + "\n",
	definitionRuns.trim() + "\n",
	definitionPlatform.trim() + "\n",
	claudeInference.trim() + "\n",
	partsArm.trim() + "\n",
	openAIInference.trim() + "\n",
]);

/** Every table the lab migrations create. */
export const LAB_TABLES = Object.freeze([
	"lab_settings",
	"lab_experiments",
	"lab_trials",
	"lab_rounds",
	"lab_definition_runs",
]);
