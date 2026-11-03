import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertInteractSchema, migrations } from "eumenes-interact/sqlite";
import { LAB_TABLES, labMigrations } from "./migrations.ts";

/** Default research database; `lab/data/` is gitignored. */
export const DEFAULT_DB_PATH = fileURLToPath(
	new URL("../data/interact.sqlite", import.meta.url),
);

export class LabDbError extends Error {
	constructor(
		readonly code: "migration_changed" | "schema_missing",
		readonly detail: string,
	) {
		super(`${code}:${detail}`);
		this.name = "LabDbError";
	}
}

const pad = (n: number) => String(n).padStart(4, "0");
const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

/**
 * Package migrations first (`interact-package/NNNN`, the id Eumenes will give them), then the lab's
 * (`lab/NNNN`). Both lists are append-only: a body that differs from what was applied is refused rather than
 * silently skipped, so an edited migration shows up before the first bring-back (plan.md §3.3).
 */
export function plannedMigrations() {
	return [
		...migrations.map((sql, i) => ({
			id: `interact-package/${pad(i + 1)}`,
			sql,
		})),
		...labMigrations.map((sql, i) => ({ id: `lab/${pad(i + 1)}`, sql })),
	];
}

/** Applies what is missing and records the ids. Returns the ids applied by this call. */
export function applyMigrations(db: Database, nowIso: string): string[] {
	db.exec(
		`CREATE TABLE IF NOT EXISTS lab_migrations (
			id TEXT PRIMARY KEY,
			sha256 TEXT NOT NULL,
			applied_at TEXT NOT NULL
		)`,
	);
	const applied = new Map(
		(
			db.query("SELECT id, sha256 FROM lab_migrations").all() as {
				id: string;
				sha256: string;
			}[]
		).map((row) => [row.id, row.sha256]),
	);
	const done: string[] = [];
	for (const { id, sql } of plannedMigrations()) {
		const digest = sha256(sql);
		const recorded = applied.get(id);
		if (recorded !== undefined) {
			if (recorded !== digest) throw new LabDbError("migration_changed", id);
			continue;
		}
		db.transaction(() => {
			db.exec(sql);
			db.query(
				"INSERT INTO lab_migrations (id, sha256, applied_at) VALUES (?, ?, ?)",
			).run(id, digest, nowIso);
		})();
		done.push(id);
	}
	assertInteractSchema(db);
	const tables = new Set(
		(
			db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((row) => row.name),
	);
	for (const table of LAB_TABLES)
		if (!tables.has(table)) throw new LabDbError("schema_missing", table);
	return done;
}

/**
 * Opens the research database: one writer connection, foreign keys on, WAL (a no-op for `:memory:`), the
 * migrations applied. The package never opens files; this host does.
 */
export function openLabDb(
	path: string = DEFAULT_DB_PATH,
	nowIso: string = new Date().toISOString(),
): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true });
	try {
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		applyMigrations(db, nowIso);
	} catch (error) {
		db.close();
		throw error;
	}
	return db;
}

/**
 * One committed write transaction. The package's writers refuse outside one, and `dispatched` has to be
 * durable before the adapter is awaited, so every host write is its own transaction.
 */
export function write<T>(db: Database, run: () => T): T {
	return db.transaction(run)();
}
