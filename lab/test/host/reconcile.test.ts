import { describe, expect, test } from "bun:test";
import {
	createRun,
	getOperation,
	getRun,
	markOperationDispatched,
	recordOperationIntent,
	transitionRun,
} from "eumenes-interact/sqlite";
import { write } from "../../host/db.ts";
import { silentLabLogger } from "../../host/log.ts";
import { insertTrial, listTrials } from "../../host/store.ts";
import { VERSIONS } from "./harness.ts";
import { reconcileOnStartup } from "../../host/reconcile.ts";
import { LAB_OWNER } from "../../host/run.ts";
import { freshDb } from "./harness.ts";

const NOW = "2026-11-03T00:00:00.000Z";

function run(db: ReturnType<typeof freshDb>, runId: string) {
	createRun(db, LAB_OWNER, {
		runId,
		skillRef: "skill",
		skillDigest: "digest",
		catalogRef: "catalog",
		catalogDigest: "digest",
		platform: "playwright-mcp",
		coreFormatVersion: 1,
		policy: { maxModelCalls: 12, retries: { default: 1 } },
		nowIso: NOW,
	});
	transitionRun(db, LAB_OWNER, runId, "running", { nowIso: NOW });
}

function operation(
	db: ReturnType<typeof freshDb>,
	runId: string,
	operationId: string,
) {
	recordOperationIntent(db, LAB_OWNER, runId, {
		request: {
			operationId,
			sessionId: "s",
			generation: 0,
			command: { action: "browser.back" },
			declaredEffect: "navigation",
		},
		nowIso: NOW,
	});
}

describe("restart reconciliation", () => {
	test("a dispatched operation becomes indeterminate with its run, and nothing is resent", () => {
		const db = freshDb();
		write(db, () => {
			run(db, "run-sent");
			operation(db, "run-sent", "op-sent");
			markOperationDispatched(db, LAB_OWNER, "op-sent", NOW);
			run(db, "run-idle");
		});
		const done = reconcileOnStartup(db, LAB_OWNER, silentLabLogger, NOW);
		expect(done.settledOperations).toBe(1);
		expect(done.indeterminateRuns).toEqual(["run-sent"]);
		expect(done.abandonedRuns).toEqual(["run-idle"]);
		expect(getOperation(db, LAB_OWNER, "op-sent")).toMatchObject({
			status: "indeterminate",
			retryable: false,
			resultCode: "host_restarted",
		});
		expect(getRun(db, LAB_OWNER, "run-sent")?.status).toBe("indeterminate");
		expect(getRun(db, LAB_OWNER, "run-idle")).toMatchObject({
			status: "failed",
			statusReason: "host_restarted",
		});
		// A second start finds nothing left to settle.
		expect(reconcileOnStartup(db, LAB_OWNER, silentLabLogger, NOW)).toEqual({
			settledOperations: 0,
			indeterminateRuns: [],
			abandonedRuns: [],
		});
	});

	test("an intent that was never dispatched is not an unsettled operation", () => {
		const db = freshDb();
		write(db, () => {
			run(db, "run-1");
			operation(db, "run-1", "op-1");
		});
		const done = reconcileOnStartup(db, LAB_OWNER, silentLabLogger, NOW);
		expect(done.settledOperations).toBe(0);
		expect(done.indeterminateRuns).toEqual([]);
		expect(getOperation(db, LAB_OWNER, "op-1")?.status).toBe("not_dispatched");
	});

	test("a run that waits for the user is left alone", () => {
		const db = freshDb();
		write(db, () => {
			run(db, "run-wait");
			transitionRun(db, LAB_OWNER, "run-wait", "needs_input", { nowIso: NOW });
		});
		reconcileOnStartup(db, LAB_OWNER, silentLabLogger, NOW);
		expect(getRun(db, LAB_OWNER, "run-wait")?.status).toBe("needs_input");
	});
});

describe("trials left running", () => {
	test("are marked interrupted with the run's status", () => {
		const db = freshDb();
		write(db, () => run(db, "run-1"));
		insertTrial(db, {
			trialId: "t-1",
			experimentId: "exp-1",
			caseId: "dev-search-base",
			split: "dev",
			arm: "arm0",
			platform: "playwright-mcp",
			executionMode: "free",
			knowledge: "none",
			repetition: 1,
			orderIndex: 0,
			runId: "run-1",
			startedAt: NOW,
			versions: VERSIONS,
			inference: { kind: "scripted" },
		});
		reconcileOnStartup(db, LAB_OWNER, silentLabLogger, NOW);
		expect(listTrials(db)[0]).toMatchObject({
			state: "interrupted",
			runStatus: "failed",
		});
	});
});
