import { Database } from "bun:sqlite";
import { migrations } from "../../src/sqlite/index.ts";
import {
	createRun,
	transitionRun,
	type CreateRunInput,
	type RunRecord,
} from "../../src/sqlite/index.ts";

/** A host connection as Eumenes opens it: in memory, foreign keys on, migrations applied in order. */
export function openDb(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	for (const sql of migrations) db.exec(sql);
	return db;
}

/** Opens the host's transaction; the store functions run inside it. */
export function openTransaction(): Database {
	const db = openDb();
	db.exec("BEGIN");
	return db;
}

export const NOW = "2026-11-03T00:00:00.000Z";
export const LATER = "2026-11-03T00:05:00.000Z";

export const OWNER_A = "owner-a";
export const OWNER_B = "owner-b";

export function runInput(
	runId: string,
	overrides: Partial<CreateRunInput> = {},
): CreateRunInput {
	return {
		runId,
		skillRef: "skill:interact.execute@1",
		skillDigest: "sha256:skill",
		catalogRef: "catalog:interact.actions@1",
		catalogDigest: "sha256:catalog",
		platform: "playwright-mcp",
		coreFormatVersion: 1,
		policy: { maxModelCalls: 20, retries: { default: 1 } },
		nowIso: NOW,
		...overrides,
	};
}

/** A run in `running`, the state operations need. */
export function startedRun(
	db: Database,
	owner = OWNER_A,
	runId = "run-1",
): RunRecord {
	createRun(db, owner, runInput(runId));
	return transitionRun(db, owner, runId, "running", { nowIso: NOW });
}

export function count(db: Database, table: string): number {
	const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
		n: number;
	};
	return row.n;
}

/** Every text value of every table, to prove a value was never stored. */
export function dumpAllText(db: Database): string {
	const tables = db
		.query("SELECT name FROM sqlite_master WHERE type = 'table'")
		.all() as { name: string }[];
	return tables
		.map(({ name }) => JSON.stringify(db.query(`SELECT * FROM ${name}`).all()))
		.join("\n");
}
