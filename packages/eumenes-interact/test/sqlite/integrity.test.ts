import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreState } from "../../src/contracts/core.ts";
import {
	TERMINAL_RUN_STATUSES,
	RUN_TRANSITIONS,
	createRun,
	forgetRun,
	getRun,
	markOperationDispatched,
	migrations,
	recordEvidence,
	recordOperationIntent,
	recordPlanRevision,
	saveCoreState,
	settleOperation,
	transitionRun,
	upsertPageProfile,
	upsertSiteScope,
	writeSiteObject,
} from "../../src/sqlite/index.ts";
import {
	LATER,
	NOW,
	OWNER_A,
	count,
	openTransaction,
	runInput,
	startedRun,
} from "./support.ts";

const STATE: CoreState = { formatVersion: 1, arm: "arm1", step: 1 };

function coreStateColumn(db: Database, runId: string): unknown {
	const row = db
		.query("SELECT core_state_json FROM interact_runs WHERE run_id = ?")
		.get(runId) as { core_state_json: string | null };
	return row.core_state_json;
}

describe("core state at the end of a run (R06)", () => {
	test("every terminal status clears it in the same update", () => {
		for (const terminal of TERMINAL_RUN_STATUSES) {
			expect(RUN_TRANSITIONS.running).toContain(terminal);
			const db = openTransaction();
			startedRun(db, OWNER_A, "r");
			saveCoreState(db, OWNER_A, "r", {
				state: STATE,
				expectedRevision: 0,
				nowIso: NOW,
			});
			expect(coreStateColumn(db, "r")).not.toBeNull();
			const ended = transitionRun(db, OWNER_A, "r", terminal, {
				nowIso: LATER,
			});
			expect(ended.coreState).toBeNull();
			expect(coreStateColumn(db, "r")).toBeNull();
			// The revision is history, not content: it stays.
			expect(ended.coreStateRevision).toBe(1);
			db.close();
		}
	});

	test("a state that is not terminal is kept, and retainCoreState keeps it at the end", () => {
		const db = openTransaction();
		startedRun(db, OWNER_A, "r");
		saveCoreState(db, OWNER_A, "r", {
			state: STATE,
			expectedRevision: 0,
			nowIso: NOW,
		});
		const waiting = transitionRun(db, OWNER_A, "r", "needs_input", {
			nowIso: LATER,
		});
		expect(waiting.coreState).toEqual(STATE);
		const failed = transitionRun(db, OWNER_A, "r", "failed", {
			nowIso: LATER,
			reason: "model_error",
			retainCoreState: true,
		});
		expect(failed.coreState).toEqual(STATE);
		db.close();
	});

	test("a finished run still refuses a late state with run_closed", () => {
		const db = openTransaction();
		startedRun(db, OWNER_A, "r");
		transitionRun(db, OWNER_A, "r", "cancelled", { nowIso: LATER });
		expect(() =>
			saveCoreState(db, OWNER_A, "r", {
				state: STATE,
				expectedRevision: 0,
				nowIso: LATER,
			}),
		).toThrow("run_closed");
		db.close();
	});
});

/** A host connection as Eumenes may open it with foreign keys left at SQLite's default (off). */
function openDbWithForeignKeys(foreignKeys: boolean): Database {
	const db = new Database(":memory:");
	db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
	for (const sql of migrations) db.exec(sql);
	db.exec("BEGIN");
	return db;
}

function interactTablesWithRunId(db: Database): string[] {
	const tables = db
		.query(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'interact_%' ORDER BY name",
		)
		.all() as { name: string }[];
	return tables
		.map(({ name }) => name)
		.filter((name) =>
			(
				db.query(`SELECT name FROM pragma_table_info('${name}')`).all() as {
					name: string;
				}[]
			).some((column) => column.name === "run_id"),
		);
}

/** A site object the runs below leave evidence on; one per connection. */
function siteObjectId(db: Database): number {
	upsertSiteScope(db, OWNER_A, "https://shop.example.org", NOW);
	upsertPageProfile(
		db,
		OWNER_A,
		"https://shop.example.org",
		{ name: "home" },
		NOW,
	);
	return writeSiteObject(db, OWNER_A, {
		origin: "https://shop.example.org",
		profile: "home",
		logicalName: "search.query",
		expectedRevision: 0,
		nowIso: NOW,
	}).id;
}

/** A finished run with a row in every table that carries its run id. */
function finishedRunWithChildren(
	db: Database,
	runId: string,
	objectId: number,
): void {
	startedRun(db, OWNER_A, runId);
	recordOperationIntent(db, OWNER_A, runId, {
		request: {
			operationId: `${runId}-op`,
			sessionId: "session",
			generation: 1,
			command: { action: "browser.back" },
			declaredEffect: "navigation",
		},
		nowIso: NOW,
	});
	recordPlanRevision(db, OWNER_A, runId, {
		reason: "retry_with_other_target",
		diff: { step: 2 },
		nowIso: NOW,
	});
	recordEvidence(db, OWNER_A, objectId, {
		outcome: "match",
		checkedAt: NOW,
		runId,
	});
	recordEvidence(db, OWNER_A, objectId, {
		outcome: "match",
		checkedAt: NOW,
		operationId: `${runId}-op`,
	});
	transitionRun(db, OWNER_A, runId, "cancelled", { nowIso: LATER });
}

describe("forgetRun does not depend on foreign keys (R07)", () => {
	for (const foreignKeys of [false, true]) {
		test(`foreign_keys=${foreignKeys ? "ON" : "OFF"}: no interact_ table keeps a row of the run`, () => {
			const db = openDbWithForeignKeys(foreignKeys);
			const objectId = siteObjectId(db);
			finishedRunWithChildren(db, "gone", objectId);
			finishedRunWithChildren(db, "kept", objectId);
			const tables = interactTablesWithRunId(db);
			expect(tables.length).toBeGreaterThan(1);
			for (const table of tables) {
				expect(count(db, `${table} WHERE run_id = 'gone'`)).toBeGreaterThan(0);
			}
			forgetRun(db, OWNER_A, "gone");
			for (const table of tables) {
				expect(count(db, `${table} WHERE run_id = 'gone'`)).toBe(0);
				expect(count(db, `${table} WHERE run_id = 'kept'`)).toBeGreaterThan(0);
			}
			expect(
				count(db, "interact_operations WHERE operation_id = 'gone-op'"),
			).toBe(0);
			expect(
				count(db, "interact_object_evidence WHERE operation_id = 'gone-op'"),
			).toBe(0);
			db.close();
		});
	}

	test("the tables forgetRun deletes from are exactly the interact_ tables with a run_id column", () => {
		const db = openDbWithForeignKeys(true);
		finishedRunWithChildren(db, "gone", siteObjectId(db));
		const deleted = new Set<string>();
		const spy = new Proxy(db, {
			get(target, property) {
				if (property === "query") {
					return (sql: string) => {
						const match = /^\s*DELETE\s+FROM\s+(\w+)/i.exec(sql);
						if (match) deleted.add(match[1] as string);
						return target.query(sql);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		forgetRun(spy, OWNER_A, "gone");
		// A table added later with a run_id column must be added to forgetRun, or this fails.
		expect([...deleted].sort()).toEqual(interactTablesWithRunId(db).sort());
		db.close();
	});
});

describe("a conditional update that changed nothing is not a success (R09)", () => {
	/** Makes SQLite skip every UPDATE of a table silently: what a lost race looks like to the caller. */
	function ignoreUpdates(db: Database, table: string): void {
		db.exec(
			`CREATE TEMP TRIGGER skip_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
		);
	}

	test("saveCoreState reports a revision_conflict", () => {
		const db = openTransaction();
		startedRun(db, OWNER_A, "r");
		ignoreUpdates(db, "interact_runs");
		expect(() =>
			saveCoreState(db, OWNER_A, "r", {
				state: STATE,
				expectedRevision: 0,
				nowIso: LATER,
			}),
		).toThrow("revision_conflict");
		db.close();
	});

	test("transitionRun reports an invalid_transition", () => {
		const db = openTransaction();
		createRun(db, OWNER_A, runInput("r"));
		ignoreUpdates(db, "interact_runs");
		expect(() =>
			transitionRun(db, OWNER_A, "r", "running", { nowIso: LATER }),
		).toThrow("invalid_transition");
		db.close();
	});

	test("dispatching and settling an operation report an invalid_transition", () => {
		const db = openTransaction();
		startedRun(db, OWNER_A, "r");
		recordOperationIntent(db, OWNER_A, "r", {
			request: {
				operationId: "op-1",
				sessionId: "session",
				generation: 1,
				command: { action: "browser.back" },
				declaredEffect: "navigation",
			},
			nowIso: NOW,
		});
		ignoreUpdates(db, "interact_operations");
		expect(() => markOperationDispatched(db, OWNER_A, "op-1", LATER)).toThrow(
			"invalid_transition",
		);
		db.exec("DROP TRIGGER skip_interact_operations");
		markOperationDispatched(db, OWNER_A, "op-1", LATER);
		ignoreUpdates(db, "interact_operations");
		expect(() =>
			settleOperation(db, OWNER_A, "op-1", {
				status: "confirmed",
				retryable: false,
				nowIso: LATER,
			}),
		).toThrow("invalid_transition");
		db.close();
	});

	describe("two connections on one WAL file", () => {
		function openFile(path: string): Database {
			const db = new Database(path);
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA busy_timeout = 0");
			return db;
		}

		function withFiles(run: (a: Database, b: Database) => void): void {
			const dir = mkdtempSync(join(tmpdir(), "interact-wal-"));
			const path = join(dir, "interact.sqlite");
			const a = openFile(path);
			for (const sql of migrations) a.exec(sql);
			a.exec("BEGIN");
			startedRun(a, OWNER_A, "r");
			a.exec("COMMIT");
			const b = openFile(path);
			try {
				run(a, b);
			} finally {
				a.close();
				b.close();
				rmSync(dir, { recursive: true, force: true });
			}
		}

		test("the writer that read the old revision loses, and the first state stays", () => {
			withFiles((a, b) => {
				a.exec("BEGIN");
				b.exec("BEGIN");
				// B takes its read snapshot before A commits.
				expect(getRun(b, OWNER_A, "r")?.coreStateRevision).toBe(0);
				expect(
					saveCoreState(a, OWNER_A, "r", {
						state: { ...STATE, step: 1 },
						expectedRevision: 0,
						nowIso: NOW,
					}),
				).toBe(1);
				a.exec("COMMIT");
				expect(() =>
					saveCoreState(b, OWNER_A, "r", {
						state: { ...STATE, step: 2 },
						expectedRevision: 0,
						nowIso: LATER,
					}),
				).toThrow();
				b.exec("ROLLBACK");
				const stored = getRun(a, OWNER_A, "r");
				expect(stored?.coreStateRevision).toBe(1);
				expect(stored?.coreState).toEqual({ ...STATE, step: 1 });
			});
		});

		test("a second save from the same revision is a revision_conflict", () => {
			withFiles((a, b) => {
				a.exec("BEGIN");
				saveCoreState(a, OWNER_A, "r", {
					state: STATE,
					expectedRevision: 0,
					nowIso: NOW,
				});
				a.exec("COMMIT");
				b.exec("BEGIN IMMEDIATE");
				expect(() =>
					saveCoreState(b, OWNER_A, "r", {
						state: { ...STATE, step: 2 },
						expectedRevision: 0,
						nowIso: LATER,
					}),
				).toThrow("revision_conflict");
				b.exec("ROLLBACK");
			});
		});
	});
});
