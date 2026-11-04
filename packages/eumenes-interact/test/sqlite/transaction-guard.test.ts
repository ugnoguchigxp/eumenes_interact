import { describe, expect, test } from "bun:test";
import {
	addLocatorCandidate,
	createRun,
	findSiteObjects,
	getRun,
	listUnsettledOperations,
	markOperationDispatched,
	recordEvidence,
	recordOperationIntent,
	recordPlanRevision,
	registerWorkflowRevision,
	saveCoreState,
	setCandidateStatus,
	settleOperation,
	transitionRun,
	upsertPageProfile,
	upsertSiteScope,
	writeSiteObject,
} from "../../src/sqlite/index.ts";
import { NOW, OWNER_A, count, openDb, runInput } from "./support.ts";

describe("writers refuse outside a transaction", () => {
	test("every writer throws not_in_transaction and writes nothing", () => {
		const db = openDb();
		expect(db.inTransaction).toBe(false);
		const writers: Record<string, () => unknown> = {
			createRun: () => createRun(db, OWNER_A, runInput("r1")),
			transitionRun: () =>
				transitionRun(db, OWNER_A, "r1", "running", { nowIso: NOW }),
			saveCoreState: () =>
				saveCoreState(db, OWNER_A, "r1", {
					state: { formatVersion: 1, arm: "arm1" },
					expectedRevision: 0,
					nowIso: NOW,
				}),
			recordPlanRevision: () =>
				recordPlanRevision(db, OWNER_A, "r1", {
					reason: "x",
					diff: {},
					nowIso: NOW,
				}),
			recordOperationIntent: () =>
				recordOperationIntent(db, OWNER_A, "r1", {
					request: {
						operationId: "op",
						sessionId: "s",
						generation: 0,
						command: { action: "browser.back" },
						declaredEffect: "none",
					},
					nowIso: NOW,
				}),
			markOperationDispatched: () =>
				markOperationDispatched(db, OWNER_A, "op", NOW),
			settleOperation: () =>
				settleOperation(db, OWNER_A, "op", {
					status: "failed",
					retryable: false,
					nowIso: NOW,
				}),
			upsertSiteScope: () =>
				upsertSiteScope(db, OWNER_A, "https://a.example", NOW),
			upsertPageProfile: () =>
				upsertPageProfile(db, OWNER_A, "https://a.example", { name: "p" }, NOW),
			writeSiteObject: () =>
				writeSiteObject(db, OWNER_A, {
					origin: "https://a.example",
					profile: "p",
					logicalName: "x",
					expectedRevision: 0,
					nowIso: NOW,
				}),
			addLocatorCandidate: () =>
				addLocatorCandidate(
					db,
					OWNER_A,
					1,
					{
						kind: "role",
						fields: { role: "x" },
						source: { adapter: "playwright-mcp", via: "snapshot" },
					},
					NOW,
				),
			setCandidateStatus: () =>
				setCandidateStatus(db, OWNER_A, 1, "disabled", { nowIso: NOW }),
			recordEvidence: () =>
				recordEvidence(db, OWNER_A, 1, {
					outcome: "match",
					checkedAt: NOW,
					observationRef: "o",
				}),
			registerWorkflowRevision: () =>
				registerWorkflowRevision(db, OWNER_A, {
					workflowId: "w",
					revision: 1,
					formatVersion: 1,
					digest: "d",
					skillRef: "s",
					catalogRef: "c",
					definition: {},
					nowIso: NOW,
				}),
		};
		for (const [name, call] of Object.entries(writers)) {
			expect(call, name).toThrow("not_in_transaction");
		}
		expect(count(db, "interact_runs")).toBe(0);
		expect(count(db, "interact_site_scopes")).toBe(0);
		expect(count(db, "interact_workflows")).toBe(0);
	});

	test("readers work outside a transaction", () => {
		const db = openDb();
		expect(getRun(db, OWNER_A, "r1")).toBeNull();
		expect(
			findSiteObjects(db, OWNER_A, { origin: "https://a.example" }),
		).toEqual([]);
	});

	test("a missing table is reported as schema_missing", () => {
		const db = openDb();
		db.exec("DROP TABLE interact_operations");
		expect(() => listUnsettledOperations(db, OWNER_A)).toThrow(
			"schema_missing",
		);
	});
});
