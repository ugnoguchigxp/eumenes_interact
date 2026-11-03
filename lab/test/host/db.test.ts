import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTERACT_TABLES, migrations } from "eumenes-interact/sqlite";
import {
	LabDbError,
	applyMigrations,
	openLabDb,
	plannedMigrations,
} from "../../host/db.ts";
import { LAB_TABLES, labMigrations } from "../../host/migrations.ts";
import {
	createRound,
	decideRound,
	getSetting,
	setSetting,
} from "../../host/store.ts";

const NOW = "2026-11-03T00:00:00.000Z";

describe("migrations", () => {
	test("the package's and the lab's apply to an empty database, with ids recorded", () => {
		const db = openLabDb(":memory:", NOW);
		const ids = (
			db.query("SELECT id FROM lab_migrations ORDER BY rowid").all() as {
				id: string;
			}[]
		).map((r) => r.id);
		expect(ids).toEqual([
			...migrations.map(
				(_, i) => `interact-package/${String(i + 1).padStart(4, "0")}`,
			),
			...labMigrations.map((_, i) => `lab/${String(i + 1).padStart(4, "0")}`),
		]);
		expect(ids[0]).toBe("interact-package/0001");
		const tables = (
			db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((r) => r.name);
		for (const t of [...INTERACT_TABLES, ...LAB_TABLES])
			expect(tables).toContain(t);
		expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
	});

	test("applying again does nothing; a changed body is refused, not skipped", () => {
		const db = openLabDb(":memory:", NOW);
		expect(applyMigrations(db, NOW)).toEqual([]);
		db.query("UPDATE lab_migrations SET sha256 = 'changed' WHERE id = ?").run(
			plannedMigrations()[0]!.id,
		);
		expect(() => applyMigrations(db, NOW)).toThrow(LabDbError);
	});

	test("a file database is opened in WAL mode and reopens without reapplying", () => {
		const dir = mkdtempSync(join(tmpdir(), "interact-lab-test-"));
		try {
			const path = join(dir, "nested", "interact.sqlite");
			const first = openLabDb(path, NOW);
			expect(first.query("PRAGMA journal_mode").get()).toEqual({
				journal_mode: "wal",
			});
			setSetting(first, "larm.baseUrl", "http://larm.test", NOW);
			first.close();
			const second = openLabDb(path, NOW);
			expect(getSetting(second, "larm.baseUrl")).toBe("http://larm.test");
			second.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("settings and rounds", () => {
	test("only the LARM base URL and profile can be stored: a token has no place", () => {
		const db = openLabDb(":memory:", NOW);
		setSetting(db, "larm.profile", "chat", NOW);
		setSetting(db, "larm.profile", "chat2", NOW);
		expect(getSetting(db, "larm.profile")).toBe("chat2");
		expect(() =>
			db
				.query(
					"INSERT INTO lab_settings (key, value, updated_at) VALUES ('larm.token', 'x', ?)",
				)
				.run(NOW),
		).toThrow();
	});

	test("a round records its hypothesis and is decided once", () => {
		const db = openLabDb(":memory:", NOW);
		createRound(db, {
			id: "r1",
			hypothesis: "h",
			changedCondition: "skill revision",
			fixedConditions: { cases: "dev" },
			nowIso: NOW,
		});
		decideRound(db, "r1", {
			results: { a: 1 },
			decision: "adopt",
			nowIso: NOW,
		});
		decideRound(db, "r1", {
			results: { a: 2 },
			decision: "reject",
			nowIso: NOW,
		});
		const row = db.query("SELECT decision, results_json FROM lab_rounds").get();
		expect(row).toEqual({ decision: "adopt", results_json: '{"a":1}' });
	});

	test("a trial must name an existing experiment and run", () => {
		const db: Database = openLabDb(":memory:", NOW);
		expect(() =>
			db
				.query(
					`INSERT INTO lab_trials (trial_id, experiment_id, case_id, split, arm, platform, execution_mode,
						knowledge, repetition, order_index, run_id, started_at, state, versions_json, inference_json)
					VALUES ('t', 'nope', 'c', 'dev', 'arm0', 'playwright-mcp', 'free', 'none', 1, 0, 'r', ?, 'running', '{}', '{}')`,
				)
				.run(NOW),
		).toThrow();
	});
});
