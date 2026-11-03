import { describe, expect, test } from "bun:test";
import {
	OPERATION_STATUSES,
	type AdapterCommand,
	type OperationRequest,
	type OperationStatus,
} from "../../src/contracts/operation.ts";
import {
	OPERATION_TRANSITIONS,
	getOperation,
	getRun,
	listOperations,
	listUnsettledOperations,
	markOperationDispatched,
	recordOperationIntent,
	redactCommand,
	settleOperation,
	transitionRun,
} from "../../src/sqlite/index.ts";
import {
	LATER,
	NOW,
	OWNER_A,
	OWNER_B,
	dumpAllText,
	openTransaction,
	startedRun,
} from "./support.ts";

const SECRET = "hunter2-correct-horse";

function request(
	operationId: string,
	command: AdapterCommand = {
		action: "page.click",
		targetRef: "e12",
		element: "Search button",
	},
): OperationRequest {
	return {
		operationId,
		sessionId: "session-1",
		generation: 3,
		observationRef: "obs-7",
		command,
		declaredEffect: "none",
	};
}

function intent(
	db: ReturnType<typeof openTransaction>,
	operationId: string,
	runId = "run-1",
	owner = OWNER_A,
) {
	return recordOperationIntent(db, owner, runId, {
		request: request(operationId),
		nowIso: NOW,
	});
}

/** Forces an existing operation into any status directly, as a test fixture only. */
function forceStatus(
	db: ReturnType<typeof openTransaction>,
	id: string,
	status: OperationStatus,
) {
	const settled = ["confirmed", "failed", "indeterminate"].includes(status);
	db.query(
		"UPDATE interact_operations SET status = ?, dispatched_at = ?, settled_at = ? WHERE operation_id = ?",
	).run(
		status,
		status === "not_dispatched" ? null : NOW,
		settled ? NOW : null,
		id,
	);
}

function operationIn(
	db: ReturnType<typeof openTransaction>,
	status: OperationStatus,
	id = `op-${status}`,
) {
	intent(db, id);
	forceStatus(db, id, status);
	return id;
}

describe("recordOperationIntent", () => {
	test("records not_dispatched, numbered in order per run", () => {
		const db = openTransaction();
		startedRun(db);
		const first = intent(db, "op-1");
		const second = intent(db, "op-2");
		expect([first.seq, second.seq]).toEqual([1, 2]);
		expect(first).toMatchObject({
			status: "not_dispatched",
			action: "page.click",
			sessionId: "session-1",
			generation: 3,
			observationRef: "obs-7",
			targetRef: "e12",
			declaredEffect: "none",
			dispatchedAt: null,
			settledAt: null,
			retryable: null,
		});
		expect(
			listOperations(db, OWNER_A, "run-1").map((o) => o.operationId),
		).toEqual(["op-1", "op-2"]);
	});

	test("typed text, select values, wait text and URL paths are never stored", () => {
		const db = openTransaction();
		startedRun(db);
		const commands: AdapterCommand[] = [
			{
				action: "page.fill",
				targetRef: "e1",
				element: "Search",
				text: SECRET,
				submit: true,
			},
			{
				action: "page.select",
				targetRef: "e2",
				element: "Country",
				values: [SECRET],
			},
			{ action: "page.press", key: "q" },
			{ action: "page.wait", text: SECRET, textGone: SECRET },
			{
				action: "browser.navigate",
				url: `https://user:${SECRET}@Site.Example:8443/path?token=${SECRET}#frag`,
			},
		];
		commands.forEach((command, index) => {
			recordOperationIntent(db, OWNER_A, "run-1", {
				request: request(`op-${index}`, command),
				inputDigest: "digest:abc123",
				nowIso: NOW,
			});
		});
		expect(dumpAllText(db)).not.toContain(SECRET);
		expect(dumpAllText(db)).not.toContain("token=");
		const stored = listOperations(db, OWNER_A, "run-1");
		expect(stored[0]?.command).toEqual({
			action: "page.fill",
			targetRef: "e1",
			element: "Search",
			textLength: SECRET.length,
			submit: true,
		});
		expect(stored[0]?.inputDigest).toBe("digest:abc123");
		expect(stored[2]?.command).toEqual({ action: "page.press", keyLength: 1 });
		expect(stored[4]?.command).toEqual({
			action: "browser.navigate",
			origin: "https://site.example:8443",
		});
	});

	test("redactCommand keeps named keys and drops non-http URLs", () => {
		expect(redactCommand({ action: "page.press", key: "Control+A" })).toEqual({
			action: "page.press",
			key: "Control+A",
		});
		expect(
			redactCommand({ action: "browser.navigate", url: "javascript:alert(1)" }),
		).toEqual({ action: "browser.navigate", origin: null });
	});

	test("needs a running run", () => {
		const db = openTransaction();
		startedRun(db);
		transitionRun(db, OWNER_A, "run-1", "needs_input", { nowIso: NOW });
		expect(() => intent(db, "op-1")).toThrow("run_not_running");
		transitionRun(db, OWNER_A, "run-1", "running", { nowIso: NOW });
		intent(db, "op-1");
		transitionRun(db, OWNER_A, "run-1", "cancelled", { nowIso: NOW });
		expect(() => intent(db, "op-2")).toThrow("run_not_running");
	});

	test("an operation id is used once, and another owner's run is not reachable", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		expect(() => intent(db, "op-1")).toThrow("already_exists");
		expect(() => intent(db, "op-2", "run-1", OWNER_B)).toThrow("not_found");
	});
});

describe("dispatch and settle", () => {
	test("dispatched is written first, then the operation settles", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		// Nothing can be confirmed or indeterminate before it was dispatched.
		for (const status of ["confirmed", "indeterminate"] as const) {
			expect(() =>
				settleOperation(db, OWNER_A, "op-1", {
					status,
					retryable: false,
					nowIso: NOW,
				}),
			).toThrow("invalid_transition");
		}
		const dispatched = markOperationDispatched(db, OWNER_A, "op-1", NOW);
		expect(dispatched).toMatchObject({
			status: "dispatched",
			dispatchedAt: NOW,
			settledAt: null,
		});
		const settled = settleOperation(db, OWNER_A, "op-1", {
			status: "confirmed",
			retryable: false,
			nowIso: LATER,
		});
		expect(settled).toMatchObject({
			status: "confirmed",
			dispatchedAt: NOW,
			settledAt: LATER,
			retryable: false,
			resultCode: null,
		});
	});

	test("a refusal before sending ends not_dispatched as failed", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		const failed = settleOperation(db, OWNER_A, "op-1", {
			status: "failed",
			code: "approval_missing",
			retryable: true,
			nowIso: NOW,
		});
		expect(failed).toMatchObject({
			status: "failed",
			dispatchedAt: null,
			resultCode: "approval_missing",
			retryable: true,
		});
	});

	test("an indeterminate result is never retryable", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		markOperationDispatched(db, OWNER_A, "op-1", NOW);
		expect(() =>
			settleOperation(db, OWNER_A, "op-1", {
				status: "indeterminate",
				code: "transport_lost",
				retryable: true,
				nowIso: NOW,
			}),
		).toThrow("invalid_input");
		const settled = settleOperation(db, OWNER_A, "op-1", {
			status: "indeterminate",
			code: "transport_lost",
			retryable: false,
			nowIso: NOW,
		});
		expect(settled.status).toBe("indeterminate");
	});

	test("dispatching needs a running run", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		transitionRun(db, OWNER_A, "run-1", "cancelled", { nowIso: NOW });
		expect(() => markOperationDispatched(db, OWNER_A, "op-1", NOW)).toThrow(
			"run_not_running",
		);
		// A late settle of an already sent operation is still recorded after a cancel.
		const db2 = openTransaction();
		startedRun(db2);
		intent(db2, "op-1");
		markOperationDispatched(db2, OWNER_A, "op-1", NOW);
		transitionRun(db2, OWNER_A, "run-1", "cancelled", { nowIso: NOW });
		expect(
			settleOperation(db2, OWNER_A, "op-1", {
				status: "indeterminate",
				retryable: false,
				nowIso: LATER,
			}).status,
		).toBe("indeterminate");
	});

	test("every pair follows OPERATION_TRANSITIONS", () => {
		for (const from of OPERATION_STATUSES) {
			// Dispatch.
			{
				const db = openTransaction();
				startedRun(db);
				const id = operationIn(db, from);
				const attempt = () => markOperationDispatched(db, OWNER_A, id, LATER);
				if (OPERATION_TRANSITIONS[from].includes("dispatched")) {
					expect(attempt().status).toBe("dispatched");
				} else {
					expect(attempt).toThrow("invalid_transition");
				}
			}
			// Settle.
			for (const to of ["confirmed", "failed", "indeterminate"] as const) {
				const db = openTransaction();
				startedRun(db);
				const id = operationIn(db, from);
				const attempt = () =>
					settleOperation(db, OWNER_A, id, {
						status: to,
						retryable: false,
						nowIso: LATER,
					});
				if (OPERATION_TRANSITIONS[from].includes(to)) {
					expect(attempt().status).toBe(to);
				} else {
					expect(attempt).toThrow("invalid_transition");
					expect(getOperation(db, OWNER_A, id)?.status).toBe(from);
				}
			}
		}
	});

	test("settled states are closed", () => {
		expect(OPERATION_TRANSITIONS.confirmed).toEqual([]);
		expect(OPERATION_TRANSITIONS.failed).toEqual([]);
		expect(OPERATION_TRANSITIONS.indeterminate).toEqual([]);
	});

	test("another owner cannot dispatch or settle", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		expect(() => markOperationDispatched(db, OWNER_B, "op-1", NOW)).toThrow(
			"not_found",
		);
		expect(getOperation(db, OWNER_B, "op-1")).toBeNull();
	});
});

describe("restart reconciliation", () => {
	test("lists dispatched and indeterminate operations of the owner and writes nothing", () => {
		const db = openTransaction();
		startedRun(db);
		startedRun(db, OWNER_B, "run-b");
		// Intents first (a run takes none while one is unsettled), then each is forced into its state.
		const ids = [
			...OPERATION_STATUSES.map((status) => `op-${status}`),
			"op-extra",
		];
		for (const id of ids) intent(db, id);
		for (const status of OPERATION_STATUSES) {
			forceStatus(db, `op-${status}`, status);
		}
		forceStatus(db, "op-extra", "dispatched");
		// An operation of another owner's run.
		intent(db, "op-b", "run-b", OWNER_B);
		markOperationDispatched(db, OWNER_B, "op-b", NOW);

		const before = dumpAllText(db);
		const listed = listUnsettledOperations(db, OWNER_A);
		expect(listed.map((op) => op.operationId).sort()).toEqual([
			"op-dispatched",
			"op-extra",
			"op-indeterminate",
		]);
		expect(listed.every((op) => op.status !== "not_dispatched")).toBe(true);
		expect(
			listUnsettledOperations(db, OWNER_B).map((op) => op.operationId),
		).toEqual(["op-b"]);
		// Reporting does not change anything: no resend, no status change.
		expect(dumpAllText(db)).toBe(before);
		expect(listUnsettledOperations(db, OWNER_A)).toEqual(listed);
	});

	test("an unsettled operation of a finished run is still reported", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		markOperationDispatched(db, OWNER_A, "op-1", NOW);
		transitionRun(db, OWNER_A, "run-1", "indeterminate", {
			nowIso: LATER,
			reason: "restart",
		});
		expect(
			listUnsettledOperations(db, OWNER_A).map((op) => op.operationId),
		).toEqual(["op-1"]);
	});
});

describe("an unknown operation is never followed by another", () => {
	function settle(
		db: ReturnType<typeof openTransaction>,
		id: string,
		status: "confirmed" | "failed" | "indeterminate",
	) {
		return settleOperation(db, OWNER_A, id, {
			status,
			retryable: false,
			nowIso: NOW,
		});
	}

	test("after an indeterminate operation no identical operation can be recorded or sent", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		markOperationDispatched(db, OWNER_A, "op-1", NOW);
		settle(db, "op-1", "indeterminate");
		expect(() => intent(db, "op-2")).toThrow("operation_unsettled");
		expect(listOperations(db, OWNER_A, "run-1")).toHaveLength(1);
	});

	test("while one is dispatched, nothing else is recorded or dispatched", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		intent(db, "op-2");
		markOperationDispatched(db, OWNER_A, "op-1", NOW);
		expect(() => intent(db, "op-3")).toThrow("operation_unsettled");
		expect(() => markOperationDispatched(db, OWNER_A, "op-2", NOW)).toThrow(
			"operation_unsettled",
		);
		expect(getOperation(db, OWNER_A, "op-2")?.status).toBe("not_dispatched");
		// A dispatched operation left by a crash blocks the same way after a restart.
		settle(db, "op-1", "indeterminate");
		expect(() => markOperationDispatched(db, OWNER_A, "op-2", NOW)).toThrow(
			"operation_unsettled",
		);
	});

	test("confirmed and failed operations do not block the next one", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		markOperationDispatched(db, OWNER_A, "op-1", NOW);
		settle(db, "op-1", "confirmed");
		intent(db, "op-2");
		markOperationDispatched(db, OWNER_A, "op-2", NOW);
		settle(db, "op-2", "failed");
		intent(db, "op-3");
		expect(markOperationDispatched(db, OWNER_A, "op-3", NOW).status).toBe(
			"dispatched",
		);
	});

	test("another run is not blocked", () => {
		const db = openTransaction();
		startedRun(db);
		startedRun(db, OWNER_A, "run-2");
		intent(db, "op-1");
		markOperationDispatched(db, OWNER_A, "op-1", NOW);
		intent(db, "op-2", "run-2");
		markOperationDispatched(db, OWNER_A, "op-2", NOW);
	});

	test("raw SQL cannot move a sent operation back to not_dispatched", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		markOperationDispatched(db, OWNER_A, "op-1", NOW);
		expect(() =>
			db.exec(
				"UPDATE interact_operations SET status = 'not_dispatched', dispatched_at = NULL",
			),
		).toThrow("interact_immutable");
		expect(getOperation(db, OWNER_A, "op-1")?.status).toBe("dispatched");
	});

	test("a run does not complete or end partial with an open operation", () => {
		for (const open of ["dispatched", "indeterminate"] as const) {
			for (const to of ["completed", "partial"] as const) {
				const db = openTransaction();
				startedRun(db);
				intent(db, "op-1");
				markOperationDispatched(db, OWNER_A, "op-1", NOW);
				if (open === "indeterminate") settle(db, "op-1", "indeterminate");
				expect(() =>
					transitionRun(db, OWNER_A, "run-1", to, { nowIso: LATER }),
				).toThrow("operation_unsettled");
				expect(getRun(db, OWNER_A, "run-1")?.status).toBe("running");
				// The ways out that do not claim success stay open.
				for (const out of [
					"indeterminate",
					"failed",
					"cancelled",
					"expired",
				] as const) {
					const copy = openTransaction();
					startedRun(copy);
					intent(copy, "op-1");
					markOperationDispatched(copy, OWNER_A, "op-1", NOW);
					expect(
						transitionRun(copy, OWNER_A, "run-1", out, { nowIso: LATER })
							.status,
					).toBe(out);
				}
			}
		}
	});

	test("a run completes once its operations are confirmed or failed", () => {
		const db = openTransaction();
		startedRun(db);
		intent(db, "op-1");
		markOperationDispatched(db, OWNER_A, "op-1", NOW);
		settle(db, "op-1", "confirmed");
		intent(db, "op-2");
		settle(db, "op-2", "failed");
		expect(
			transitionRun(db, OWNER_A, "run-1", "completed", { nowIso: LATER })
				.status,
		).toBe("completed");
	});
});
