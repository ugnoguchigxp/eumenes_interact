import type { PlatformId } from "../contracts/common.ts";
import type { CoreState, RunPolicy } from "../contracts/core.ts";
import type { InteractDb } from "../contracts/db.ts";
import { PLATFORM_IDS } from "../contracts/common.ts";
import {
	RUN_STATUSES,
	TERMINAL_RUN_STATUSES,
	type RunStatus,
} from "../contracts/run.ts";
import {
	assertWritable,
	changedRows,
	guarded,
	isRecord,
	readInteger,
	readJson,
	readJsonValue,
	readNullableInteger,
	readNullableText,
	readText,
} from "./db.ts";
import { InteractStoreError } from "./errors.ts";
import {
	invalid,
	listLimit,
	requireCode,
	requireDigest,
	requireId,
	requireInteger,
	requireText,
	requireTimestamp,
	toJson,
} from "./validate.ts";

/** Run states live in the contracts (plan.md §9); re-exported for `/sqlite` callers. */
export { RUN_STATUSES, TERMINAL_RUN_STATUSES };
export type { RunStatus };

/**
 * Allowed run transitions. Terminal states have none. `indeterminate` is only reachable from a run
 * that may have sent something (`running`, `needs_input`).
 */
export const RUN_TRANSITIONS: Readonly<
	Record<RunStatus, readonly RunStatus[]>
> = {
	queued: ["running", "failed", "cancelled", "expired"],
	running: [
		"needs_input",
		"completed",
		"partial",
		"failed",
		"cancelled",
		"expired",
		"indeterminate",
	],
	needs_input: ["running", "failed", "cancelled", "expired", "indeterminate"],
	completed: [],
	partial: [],
	failed: [],
	cancelled: [],
	expired: [],
	indeterminate: [],
};

export function isTerminalRunStatus(status: RunStatus): boolean {
	return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * Refuses while the run has an operation that may have reached the platform and is not settled as
 * `confirmed` or `failed` (`dispatched`, `indeterminate`).
 */
export function assertNoUnsettledOperation(
	db: InteractDb,
	runId: string,
): void {
	const row = guarded(() =>
		db
			.query(
				"SELECT 1 AS one FROM interact_operations WHERE run_id = ? AND status IN ('dispatched', 'indeterminate') LIMIT 1",
			)
			.get(runId),
	);
	if (row != null) throw new InteractStoreError("operation_unsettled");
}

export type RunRecord = {
	runId: string;
	owner: string;
	status: RunStatus;
	statusReason: string | null;
	/** The frozen workflow revision; `null` for a run without a definition. */
	workflow: { id: string; revision: number; digest: string } | null;
	skill: { ref: string; digest: string };
	catalog: { ref: string; digest: string };
	platform: PlatformId;
	coreFormatVersion: number;
	policy: RunPolicy;
	deadlineAt: string | null;
	coreState: CoreState | null;
	coreStateRevision: number;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
};

export type CreateRunInput = {
	runId: string;
	/** A registered revision of the owner's; its digest is frozen into the run. */
	workflow?: { id: string; revision: number };
	skillRef: string;
	skillDigest: string;
	catalogRef: string;
	catalogDigest: string;
	platform: PlatformId;
	coreFormatVersion: number;
	policy: RunPolicy;
	deadlineAt?: string;
	nowIso: string;
};

const RUN_COLUMNS = `run_id, owner, status, status_reason, workflow_id, workflow_revision,
	definition_digest, skill_ref, skill_digest, catalog_ref, catalog_digest, platform,
	core_format_version, policy_json, deadline_at, core_state_json, core_state_revision,
	created_at, updated_at, started_at, finished_at`;

function isRunStatus(value: string): value is RunStatus {
	return (RUN_STATUSES as readonly string[]).includes(value);
}

function isPolicy(value: unknown): value is RunPolicy {
	return (
		isRecord(value) &&
		typeof value["maxModelCalls"] === "number" &&
		isRecord(value["retries"])
	);
}

function isCoreState(value: unknown): value is CoreState {
	return (
		isRecord(value) &&
		typeof value["formatVersion"] === "number" &&
		typeof value["arm"] === "string"
	);
}

function readRun(row: unknown): RunRecord {
	const status = readText(row, "status");
	const platform = readText(row, "platform");
	if (
		!isRunStatus(status) ||
		!(PLATFORM_IDS as readonly string[]).includes(platform)
	) {
		throw new InteractStoreError("corrupt_row");
	}
	const workflowId = readNullableText(row, "workflow_id");
	const workflowRevision = readNullableInteger(row, "workflow_revision");
	const definitionDigest = readNullableText(row, "definition_digest");
	const stateText = readNullableText(row, "core_state_json");
	return {
		runId: readText(row, "run_id"),
		owner: readText(row, "owner"),
		status,
		statusReason: readNullableText(row, "status_reason"),
		workflow:
			workflowId === null ||
			workflowRevision === null ||
			definitionDigest === null
				? null
				: {
						id: workflowId,
						revision: workflowRevision,
						digest: definitionDigest,
					},
		skill: {
			ref: readText(row, "skill_ref"),
			digest: readText(row, "skill_digest"),
		},
		catalog: {
			ref: readText(row, "catalog_ref"),
			digest: readText(row, "catalog_digest"),
		},
		platform: platform as PlatformId,
		coreFormatVersion: readInteger(row, "core_format_version"),
		policy: readJson(row, "policy_json", isPolicy),
		deadlineAt: readNullableText(row, "deadline_at"),
		coreState:
			stateText === null ? null : readJson(row, "core_state_json", isCoreState),
		coreStateRevision: readInteger(row, "core_state_revision"),
		createdAt: readText(row, "created_at"),
		updatedAt: readText(row, "updated_at"),
		startedAt: readNullableText(row, "started_at"),
		finishedAt: readNullableText(row, "finished_at"),
	};
}

/** Creates a `queued` run and freezes versions, digests, policy and deadline (plan.md §9). */
export function createRun(
	db: InteractDb,
	owner: string,
	input: CreateRunInput,
): RunRecord {
	assertWritable(db);
	requireId(owner, "owner");
	const runId = requireId(input.runId, "runId");
	requireText(input.skillRef, "skillRef", 128);
	requireDigest(input.skillDigest, "skillDigest");
	requireText(input.catalogRef, "catalogRef", 128);
	requireDigest(input.catalogDigest, "catalogDigest");
	if (!(PLATFORM_IDS as readonly string[]).includes(input.platform)) {
		throw invalid("platform");
	}
	requireInteger(input.coreFormatVersion, "coreFormatVersion", 1);
	if (!isPolicy(input.policy)) throw invalid("policy");
	if (input.deadlineAt !== undefined) {
		requireTimestamp(input.deadlineAt, "deadlineAt");
	}
	const nowIso = requireTimestamp(input.nowIso, "nowIso");
	const policyJson = toJson(input.policy, "policy");

	// run_id is a global key. The answer for an id that is taken is one fixed error, whoever owns it:
	// the check carries no owner, runs before every owner-scoped lookup, and a lost race on the
	// primary key (below) gives the very same error.
	if (
		guarded(() =>
			db
				.query("SELECT 1 AS one FROM interact_runs WHERE run_id = ?")
				.get(runId),
		) != null
	) {
		throw new InteractStoreError("already_exists");
	}
	let definitionDigest: string | null = null;
	if (input.workflow !== undefined) {
		const row = guarded(() =>
			db
				.query(
					"SELECT digest FROM interact_workflow_revisions WHERE owner = ? AND workflow_id = ? AND revision = ?",
				)
				.get(owner, input.workflow?.id ?? "", input.workflow?.revision ?? 0),
		);
		if (row == null) throw new InteractStoreError("not_found");
		definitionDigest = readText(row, "digest");
	}
	insertRun(() =>
		db
			.query(
				`INSERT INTO interact_runs (run_id, owner, status, workflow_id, workflow_revision,
					definition_digest, skill_ref, skill_digest, catalog_ref, catalog_digest, platform,
					core_format_version, policy_json, deadline_at, created_at, updated_at)
				VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				runId,
				owner,
				input.workflow?.id ?? null,
				input.workflow?.revision ?? null,
				definitionDigest,
				input.skillRef,
				input.skillDigest,
				input.catalogRef,
				input.catalogDigest,
				input.platform,
				input.coreFormatVersion,
				policyJson,
				input.deadlineAt ?? null,
				nowIso,
				nowIso,
			),
	);
	return requireRun(db, owner, runId);
}

/** An INSERT that loses the run_id primary key is the same `already_exists`, not a distinct error. */
function insertRun(insert: () => unknown): void {
	try {
		guarded(insert);
	} catch (error) {
		if (
			error instanceof Error &&
			!(error instanceof InteractStoreError) &&
			/UNIQUE constraint failed: interact_runs\.run_id/i.test(error.message)
		)
			throw new InteractStoreError("already_exists");
		throw error;
	}
}

/** A run of this owner, or `null`. Another owner's run is indistinguishable from a missing one. */
export function getRun(
	db: InteractDb,
	owner: string,
	runId: string,
): RunRecord | null {
	requireId(owner, "owner");
	requireId(runId, "runId");
	const row = guarded(() =>
		db
			.query(
				`SELECT ${RUN_COLUMNS} FROM interact_runs WHERE owner = ? AND run_id = ?`,
			)
			.get(owner, runId),
	);
	return row == null ? null : readRun(row);
}

export function requireRun(
	db: InteractDb,
	owner: string,
	runId: string,
): RunRecord {
	const run = getRun(db, owner, runId);
	if (run === null) throw new InteractStoreError("not_found");
	return run;
}

/** Explicit owner-scoped forgetting. Active runs must be stopped by the host first. */
export function forgetRun(db: InteractDb, owner: string, runId: string): void {
	assertWritable(db);
	const run = requireRun(db, owner, runId);
	if (!isTerminalRunStatus(run.status))
		throw new InteractStoreError("run_not_terminal");
	// Every child table is deleted by hand, children first: the cascade only works when the host turned
	// `PRAGMA foreign_keys` on, and a leftover operation row would keep a masked command after "forget".
	guarded(() => {
		db.query(
			"DELETE FROM interact_object_evidence WHERE run_id = ? OR operation_id IN (SELECT operation_id FROM interact_operations WHERE run_id = ?)",
		).run(runId, runId);
		db.query("DELETE FROM interact_operations WHERE run_id = ?").run(runId);
		db.query("DELETE FROM interact_plan_revisions WHERE run_id = ?").run(runId);
		db.query("DELETE FROM interact_runs WHERE run_id = ? AND owner = ?").run(
			runId,
			owner,
		);
	});
}

/** Runs of an owner, newest first, optionally only some statuses. */
export function listRuns(
	db: InteractDb,
	owner: string,
	options: { statuses?: readonly RunStatus[]; limit?: number } = {},
): RunRecord[] {
	requireId(owner, "owner");
	const statuses = options.statuses ?? RUN_STATUSES;
	for (const status of statuses) {
		if (!isRunStatus(status)) throw invalid("statuses");
	}
	const marks = statuses.map(() => "?").join(", ");
	const rows = guarded(() =>
		db
			.query(
				`SELECT ${RUN_COLUMNS} FROM interact_runs WHERE owner = ? AND status IN (${marks})
				ORDER BY created_at DESC, run_id LIMIT ?`,
			)
			.all(owner, ...statuses, listLimit(options.limit)),
	);
	return rows.map((row) => readRun(row));
}

/**
 * Moves a run along `RUN_TRANSITIONS`. `completed` and `partial` also need every operation settled. `reason` is a fixed classification code (never free text).
 * `startedAt` is set on the first `running`, `finishedAt` on a terminal state.
 * A terminal state also clears `core_state_json` in the same UPDATE (it holds the request, page text
 * and input values and is only needed to continue); the terminal-immutable trigger looks at the OLD
 * status, so this write passes. `retainCoreState: true` keeps it, for hosts that replay failed runs.
 * A lost race (the row is no longer in the status that was read) is an `invalid_transition`.
 */
export function transitionRun(
	db: InteractDb,
	owner: string,
	runId: string,
	to: RunStatus,
	options: { nowIso: string; reason?: string; retainCoreState?: boolean },
): RunRecord {
	assertWritable(db);
	if (!isRunStatus(to)) throw invalid("to");
	const nowIso = requireTimestamp(options.nowIso, "nowIso");
	const reason =
		options.reason === undefined ? null : requireCode(options.reason, "reason");
	const run = requireRun(db, owner, runId);
	if (!RUN_TRANSITIONS[run.status].includes(to)) {
		throw new InteractStoreError("invalid_transition");
	}
	// A run does not finish as done while an operation's outcome is open; it can still fail, be
	// cancelled or expire, or become indeterminate.
	if (to === "completed" || to === "partial") {
		assertNoUnsettledOperation(db, runId);
	}
	const terminal = isTerminalRunStatus(to);
	const clearCoreState = terminal && options.retainCoreState !== true;
	guarded(() => {
		db.query(
			`UPDATE interact_runs SET status = ?, status_reason = ?, updated_at = ?,
				started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
				finished_at = CASE WHEN ? THEN ? ELSE NULL END,
				core_state_json = CASE WHEN ? THEN NULL ELSE core_state_json END
			WHERE owner = ? AND run_id = ? AND status = ?`,
		).run(
			to,
			reason,
			nowIso,
			to,
			nowIso,
			terminal ? 1 : 0,
			nowIso,
			clearCoreState ? 1 : 0,
			owner,
			runId,
			run.status,
		);
		if (changedRows(db) !== 1) {
			throw new InteractStoreError("invalid_transition");
		}
	});
	return requireRun(db, owner, runId);
}

/**
 * Stores the core's state. `expectedRevision` is the revision the caller read (0 before the first
 * save); another value is a `revision_conflict`. A terminal run refuses (`run_closed`): a late result
 * never rewrites a finished run. Returns the new revision.
 */
export function saveCoreState(
	db: InteractDb,
	owner: string,
	runId: string,
	input: { state: CoreState; expectedRevision: number; nowIso: string },
): number {
	assertWritable(db);
	const expected = requireInteger(
		input.expectedRevision,
		"expectedRevision",
		0,
	);
	const nowIso = requireTimestamp(input.nowIso, "nowIso");
	if (!isCoreState(input.state)) throw invalid("state");
	const stateJson = toJson(input.state, "state");
	const run = requireRun(db, owner, runId);
	if (isTerminalRunStatus(run.status))
		throw new InteractStoreError("run_closed");
	if (input.state.formatVersion !== run.coreFormatVersion) {
		throw invalid("state");
	}
	if (run.coreStateRevision !== expected) {
		throw new InteractStoreError("revision_conflict");
	}
	// Another connection may have saved between the read above and this write: the revision condition
	// then matches no row, which is a conflict, not a success.
	guarded(() => {
		db.query(
			`UPDATE interact_runs SET core_state_json = ?, core_state_revision = ?, updated_at = ?
			WHERE owner = ? AND run_id = ? AND core_state_revision = ?`,
		).run(stateJson, expected + 1, nowIso, owner, runId, expected);
		if (changedRows(db) !== 1) {
			throw new InteractStoreError("revision_conflict");
		}
	});
	return expected + 1;
}

export type PlanRevision = {
	revision: number;
	reason: string;
	diff: unknown;
	createdAt: string;
};

/**
 * Appends a runtime plan revision (reason and diff) before the changed plan is used (plan.md §6.3).
 * Numbered from 1 per run. Returns the new revision number.
 */
export function recordPlanRevision(
	db: InteractDb,
	owner: string,
	runId: string,
	input: { reason: string; diff: unknown; nowIso: string },
): number {
	assertWritable(db);
	const reason = requireText(input.reason, "reason", 2000);
	const nowIso = requireTimestamp(input.nowIso, "nowIso");
	const diffJson = toJson(input.diff, "diff");
	const run = requireRun(db, owner, runId);
	if (isTerminalRunStatus(run.status))
		throw new InteractStoreError("run_closed");
	const row = guarded(() =>
		db
			.query(
				"SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM interact_plan_revisions WHERE run_id = ?",
			)
			.get(runId),
	);
	const revision = readInteger(row, "next");
	guarded(() =>
		db
			.query(
				"INSERT INTO interact_plan_revisions (run_id, revision, reason, diff_json, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(runId, revision, reason, diffJson, nowIso),
	);
	return revision;
}

export function listPlanRevisions(
	db: InteractDb,
	owner: string,
	runId: string,
): PlanRevision[] {
	requireRun(db, owner, runId);
	const rows = guarded(() =>
		db
			.query(
				"SELECT revision, reason, diff_json, created_at FROM interact_plan_revisions WHERE run_id = ? ORDER BY revision",
			)
			.all(runId),
	);
	return rows.map((row) => ({
		revision: readInteger(row, "revision"),
		reason: readText(row, "reason"),
		diff: readJsonValue(row, "diff_json"),
		createdAt: readText(row, "created_at"),
	}));
}
