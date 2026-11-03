import type { Database } from "bun:sqlite";
import {
	getRun,
	isTerminalRunStatus,
	listRuns,
	listUnsettledOperations,
	settleOperation,
	transitionRun,
} from "eumenes-interact/sqlite";
import { write } from "./db.ts";
import type { LabLogger } from "./log.ts";

const LIMIT = 1000;

export type Reconciled = {
	/** Operations that were `dispatched` and are now settled as `indeterminate`. */
	settledOperations: number;
	/** Runs moved to `indeterminate` (a sent operation of unknown outcome). */
	indeterminateRuns: string[];
	/** Runs that never sent anything and were still open: moved to `failed`. */
	abandonedRuns: string[];
};

/**
 * Restart reconciliation (plan.md §9). A process that died cannot know how a sent operation ended, so every
 * `dispatched` operation becomes `indeterminate` and its run too; nothing is ever sent again. A run that was
 * still open without any unsettled operation sent nothing and just fails. Trials left `running` are marked
 * `interrupted`. Runs waiting in `needs_input` are left alone: the lab does not resume them, and they sent
 * nothing unsettled.
 */
export function reconcileOnStartup(
	db: Database,
	owner: string,
	logger: LabLogger,
	nowIso: string = new Date().toISOString(),
): Reconciled {
	const result = write(db, (): Reconciled => {
		const unsettled = listUnsettledOperations(db, owner, { limit: LIMIT });
		let settledOperations = 0;
		for (const op of unsettled) {
			if (op.status !== "dispatched") continue;
			settleOperation(db, owner, op.operationId, {
				status: "indeterminate",
				code: "host_restarted",
				retryable: false,
				nowIso,
			});
			settledOperations++;
		}
		const indeterminate = new Set<string>();
		for (const op of unsettled) {
			const run = getRun(db, owner, op.runId);
			if (!run || isTerminalRunStatus(run.status)) continue;
			transitionRun(db, owner, run.runId, "indeterminate", {
				nowIso,
				reason: "host_restarted",
			});
			indeterminate.add(run.runId);
		}
		const abandoned: string[] = [];
		for (const run of listRuns(db, owner, {
			statuses: ["queued", "running"],
			limit: LIMIT,
		})) {
			if (indeterminate.has(run.runId)) continue;
			transitionRun(db, owner, run.runId, "failed", {
				nowIso,
				reason: "host_restarted",
			});
			abandoned.push(run.runId);
		}
		db.query(
			`UPDATE lab_trials SET state = 'interrupted', finished_at = ?,
				run_status = (SELECT status FROM interact_runs r WHERE r.run_id = lab_trials.run_id)
			WHERE state = 'running'`,
		).run(nowIso);
		return {
			settledOperations,
			indeterminateRuns: [...indeterminate],
			abandonedRuns: abandoned,
		};
	});
	logger.lab("reconcile.run", {
		correlationId: "startup",
		count: result.settledOperations + result.abandonedRuns.length,
	});
	return result;
}
