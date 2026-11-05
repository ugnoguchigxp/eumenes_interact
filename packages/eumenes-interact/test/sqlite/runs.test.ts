import { describe, expect, test } from "bun:test";
import type { CoreState } from "../../src/contracts/core.ts";
import {
	RUN_STATUSES,
	RUN_TRANSITIONS,
	createRun,
	forgetRun,
	getOperation,
	recordOperationIntent,
	getRun,
	listPlanRevisions,
	listRuns,
	recordPlanRevision,
	registerWorkflowRevision,
	saveCoreState,
	transitionRun,
	type RunStatus,
} from "../../src/sqlite/index.ts";
import {
	LATER,
	NOW,
	OWNER_A,
	OWNER_B,
	openTransaction,
	runInput,
	startedRun,
} from "./support.ts";

const STATE: CoreState = { formatVersion: 1, arm: "arm1", step: 1 };

test("forgetting requires a stopped run and its owner, and removes the run", () => {
	const db = openTransaction();
	createRun(db, OWNER_A, runInput("forget-me"));
	expect(() => forgetRun(db, OWNER_B, "forget-me")).toThrow("not_found");
	expect(() => forgetRun(db, OWNER_A, "forget-me")).toThrow("run_not_terminal");
	transitionRun(db, OWNER_A, "forget-me", "running", { nowIso: NOW });
	recordOperationIntent(db, OWNER_A, "forget-me", {
		request: {
			operationId: "forgotten-intent",
			sessionId: "session",
			generation: 1,
			command: { action: "browser.back" },
			declaredEffect: "navigation",
		},
		nowIso: NOW,
	});
	transitionRun(db, OWNER_A, "forget-me", "cancelled", { nowIso: LATER });
	forgetRun(db, OWNER_A, "forget-me");
	expect(getRun(db, OWNER_A, "forget-me")).toBeNull();
	expect(getOperation(db, OWNER_A, "forgotten-intent")).toBeNull();
	db.close();
});

/** Puts a fresh run into any status directly, as a test fixture only. */
function runIn(db: ReturnType<typeof openTransaction>, status: RunStatus) {
	const id = `run-${status}`;
	createRun(db, OWNER_A, runInput(id));
	const finished = !["queued", "running", "needs_input"].includes(status);
	db.query(
		"UPDATE interact_runs SET status = ?, finished_at = ? WHERE run_id = ?",
	).run(status, finished ? NOW : null, id);
	return id;
}

describe("createRun and getRun", () => {
	test("a run starts queued with its versions, policy and deadline frozen", () => {
		const db = openTransaction();
		const run = createRun(
			db,
			OWNER_A,
			runInput("r1", { deadlineAt: "2026-11-03T01:00:00Z" }),
		);
		expect(run).toMatchObject({
			runId: "r1",
			owner: OWNER_A,
			status: "queued",
			workflow: null,
			skill: { ref: "skill:interact.execute@1", digest: "sha256:skill" },
			catalog: { ref: "catalog:interact.actions@1", digest: "sha256:catalog" },
			platform: "playwright-mcp",
			coreFormatVersion: 1,
			policy: { maxModelCalls: 20, retries: { default: 1 } },
			deadlineAt: "2026-11-03T01:00:00Z",
			coreState: null,
			coreStateRevision: 0,
			startedAt: null,
			finishedAt: null,
		});
	});

	test("the same run id twice is refused", () => {
		const db = openTransaction();
		createRun(db, OWNER_A, runInput("r1"));
		expect(() => createRun(db, OWNER_A, runInput("r1"))).toThrow(
			"already_exists",
		);
		expect(() => createRun(db, OWNER_B, runInput("r1"))).toThrow(
			"already_exists",
		);
	});

	test("a workflow revision's digest is frozen into the run", () => {
		const db = openTransaction();
		registerWorkflowRevision(db, OWNER_A, {
			workflowId: "site-search",
			revision: 1,
			formatVersion: 1,
			digest: "sha256:def1",
			skillRef: "skill:interact.execute@1",
			catalogRef: "catalog:interact.actions@1",
			definition: { id: "site-search" },
			nowIso: NOW,
		});
		const run = createRun(
			db,
			OWNER_A,
			runInput("r1", { workflow: { id: "site-search", revision: 1 } }),
		);
		expect(run.workflow).toEqual({
			id: "site-search",
			revision: 1,
			digest: "sha256:def1",
		});
		expect(() =>
			createRun(
				db,
				OWNER_A,
				runInput("r2", { workflow: { id: "site-search", revision: 2 } }),
			),
		).toThrow("not_found");
		// Another owner's revision is not visible.
		expect(() =>
			createRun(
				db,
				OWNER_B,
				runInput("r3", { workflow: { id: "site-search", revision: 1 } }),
			),
		).toThrow("not_found");
	});

	test("inputs are validated", () => {
		const db = openTransaction();
		expect(() => createRun(db, OWNER_A, runInput("has space"))).toThrow(
			"invalid_input",
		);
		expect(() =>
			createRun(db, OWNER_A, runInput("r1", { nowIso: "yesterday" })),
		).toThrow("invalid_input");
		expect(() =>
			createRun(
				db,
				OWNER_A,
				runInput("r1", { platform: "selenium" as "playwright-mcp" }),
			),
		).toThrow("invalid_input");
	});

	test("owners only see their own runs", () => {
		const db = openTransaction();
		createRun(db, OWNER_A, runInput("r1"));
		expect(getRun(db, OWNER_A, "r1")).not.toBeNull();
		expect(getRun(db, OWNER_B, "r1")).toBeNull();
		expect(listRuns(db, OWNER_B)).toEqual([]);
		expect(listRuns(db, OWNER_A).map((run) => run.runId)).toEqual(["r1"]);
		expect(() =>
			transitionRun(db, OWNER_B, "r1", "running", { nowIso: NOW }),
		).toThrow("not_found");
	});
});

describe("transitionRun", () => {
	test("every pair follows RUN_TRANSITIONS", () => {
		for (const from of RUN_STATUSES) {
			for (const to of RUN_STATUSES) {
				const db = openTransaction();
				const id = runIn(db, from);
				const attempt = () =>
					transitionRun(db, OWNER_A, id, to, { nowIso: LATER });
				if (RUN_TRANSITIONS[from].includes(to)) {
					expect(attempt().status).toBe(to);
				} else {
					expect(attempt).toThrow("invalid_transition");
					expect(getRun(db, OWNER_A, id)?.status).toBe(from);
				}
			}
		}
	});

	test("the table keeps terminal states closed and indeterminate to running/needs_input", () => {
		for (const terminal of [
			"completed",
			"partial",
			"failed",
			"cancelled",
			"expired",
			"indeterminate",
		] as const) {
			expect(RUN_TRANSITIONS[terminal]).toEqual([]);
		}
		const into = RUN_STATUSES.filter((status) =>
			RUN_TRANSITIONS[status].includes("indeterminate"),
		);
		expect(into).toEqual(["running", "needs_input"]);
	});

	test("times and reason are recorded", () => {
		const db = openTransaction();
		startedRun(db);
		const needs = transitionRun(db, OWNER_A, "run-1", "needs_input", {
			nowIso: LATER,
			reason: "approval_required",
		});
		expect(needs).toMatchObject({
			status: "needs_input",
			statusReason: "approval_required",
			startedAt: NOW,
			finishedAt: null,
		});
		// startedAt is kept on the second running.
		const again = transitionRun(db, OWNER_A, "run-1", "running", {
			nowIso: LATER,
		});
		expect(again.startedAt).toBe(NOW);
		const done = transitionRun(db, OWNER_A, "run-1", "completed", {
			nowIso: LATER,
		});
		expect(done.finishedAt).toBe(LATER);
	});

	test("a reason must be a fixed code", () => {
		const db = openTransaction();
		createRun(db, OWNER_A, runInput("r1"));
		expect(() =>
			transitionRun(db, OWNER_A, "r1", "running", {
				nowIso: NOW,
				reason: "The user said so",
			}),
		).toThrow("invalid_input");
	});
});

describe("saveCoreState", () => {
	test("saves with the expected revision and bumps it", () => {
		const db = openTransaction();
		startedRun(db);
		const first = saveCoreState(db, OWNER_A, "run-1", {
			state: STATE,
			expectedRevision: 0,
			nowIso: NOW,
		});
		expect(first).toBe(1);
		const second = saveCoreState(db, OWNER_A, "run-1", {
			state: { ...STATE, step: 2 },
			expectedRevision: 1,
			nowIso: LATER,
		});
		expect(second).toBe(2);
		const run = getRun(db, OWNER_A, "run-1");
		expect(run?.coreStateRevision).toBe(2);
		expect(run?.coreState).toEqual({ ...STATE, step: 2 });
	});

	test("a stale revision is a conflict and changes nothing", () => {
		const db = openTransaction();
		startedRun(db);
		saveCoreState(db, OWNER_A, "run-1", {
			state: STATE,
			expectedRevision: 0,
			nowIso: NOW,
		});
		expect(() =>
			saveCoreState(db, OWNER_A, "run-1", {
				state: { ...STATE, step: 9 },
				expectedRevision: 0,
				nowIso: NOW,
			}),
		).toThrow("revision_conflict");
		expect(getRun(db, OWNER_A, "run-1")?.coreState).toEqual(STATE);
	});

	test("a finished run refuses and another owner cannot save", () => {
		const db = openTransaction();
		startedRun(db);
		expect(() =>
			saveCoreState(db, OWNER_B, "run-1", {
				state: STATE,
				expectedRevision: 0,
				nowIso: NOW,
			}),
		).toThrow("not_found");
		transitionRun(db, OWNER_A, "run-1", "cancelled", { nowIso: NOW });
		expect(() =>
			saveCoreState(db, OWNER_A, "run-1", {
				state: STATE,
				expectedRevision: 0,
				nowIso: NOW,
			}),
		).toThrow("run_closed");
	});

	test("the state's formatVersion must be the frozen one", () => {
		const db = openTransaction();
		startedRun(db);
		expect(() =>
			saveCoreState(db, OWNER_A, "run-1", {
				state: { formatVersion: 2, arm: "arm1" } as unknown as CoreState,
				expectedRevision: 0,
				nowIso: NOW,
			}),
		).toThrow("invalid_input");
	});
});

describe("plan revisions", () => {
	test("are numbered per run and keep reason and diff", () => {
		const db = openTransaction();
		startedRun(db);
		startedRun(db, OWNER_A, "run-2");
		const diff = { replace: [{ step: "search", with: "search2" }] };
		expect(
			recordPlanRevision(db, OWNER_A, "run-1", {
				reason: "The page changed",
				diff,
				nowIso: NOW,
			}),
		).toBe(1);
		expect(
			recordPlanRevision(db, OWNER_A, "run-1", {
				reason: "Again",
				diff: {},
				nowIso: LATER,
			}),
		).toBe(2);
		expect(
			recordPlanRevision(db, OWNER_A, "run-2", {
				reason: "Other run",
				diff: {},
				nowIso: NOW,
			}),
		).toBe(1);
		expect(listPlanRevisions(db, OWNER_A, "run-1")).toEqual([
			{ revision: 1, reason: "The page changed", diff, createdAt: NOW },
			{ revision: 2, reason: "Again", diff: {}, createdAt: LATER },
		]);
		expect(() => listPlanRevisions(db, OWNER_B, "run-1")).toThrow("not_found");
	});

	test("a finished run takes no more revisions", () => {
		const db = openTransaction();
		startedRun(db);
		transitionRun(db, OWNER_A, "run-1", "failed", { nowIso: NOW });
		expect(() =>
			recordPlanRevision(db, OWNER_A, "run-1", {
				reason: "late",
				diff: {},
				nowIso: NOW,
			}),
		).toThrow("run_closed");
	});
});
