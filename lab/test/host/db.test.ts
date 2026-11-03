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

describe("the live split migration", () => {
	test("rebuilds lab_trials keeping its rows, and then accepts a live trial", () => {
		const db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		// A database from before live cases: everything up to lab/0001.
		db.exec(
			"CREATE TABLE lab_migrations (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)",
		);
		const before = plannedMigrations().filter(
			(m) => !m.id.startsWith("lab/") || m.id === "lab/0001",
		);
		for (const m of before) {
			db.exec(m.sql);
			db.query("INSERT INTO lab_migrations VALUES (?, ?, ?)").run(
				m.id,
				new Bun.CryptoHasher("sha256").update(m.sql).digest("hex"),
				NOW,
			);
		}
		db.exec(`INSERT INTO lab_experiments (id, name, created_at, case_ids_json, case_digest, includes_holdout,
			repetitions, arms_json, budget_json, tolerance_json, stop_rule_json, inference_kind)
			VALUES ('e', 'n', '${NOW}', '[]', 'd', 0, 1, '[]', '{}', '{}', '{}', 'scripted')`);
		db.exec(`INSERT INTO interact_runs (run_id, owner, status, skill_ref, skill_digest, catalog_ref,
			catalog_digest, platform, core_format_version, policy_json, created_at, updated_at)
			VALUES ('r', 'lab', 'queued', 's', 'd', 'c', 'd', 'playwright-mcp', 1,
			'{"maxModelCalls":12,"retries":{}}', '${NOW}', '${NOW}')`);
		const trial = (id: string, split: string) =>
			db
				.query(
					`INSERT INTO lab_trials (trial_id, experiment_id, case_id, split, arm, platform, execution_mode,
						knowledge, repetition, order_index, run_id, started_at, state, versions_json, inference_json)
					VALUES (?, 'e', 'c', ?, 'arm0', 'playwright-mcp', 'free', 'none', 1, 0, 'r', ?, 'running', '{}', '{}')`,
				)
				.run(id, split, NOW);
		trial("old", "dev");
		expect(() => trial("live-too-early", "live")).toThrow();
		const applied = applyMigrations(db, NOW);
		expect(applied[0]).toBe("lab/0002");
		// The experiments table was rebuilt under a trial that points at it: the row survives, the keys hold,
		// and the Claude inference is now a valid kind.
		expect(applied).toContain("lab/0005");
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		db.exec(`INSERT INTO lab_experiments (id, name, created_at, case_ids_json, case_digest, includes_holdout,
			repetitions, arms_json, budget_json, tolerance_json, stop_rule_json, inference_kind)
			VALUES ('c', 'n', '${NOW}', '[]', 'd', 0, 1, '[]', '{}', '{}', '{}', 'claude')`);
		expect(() =>
			db.exec(`INSERT INTO lab_experiments (id, name, created_at, case_ids_json, case_digest, includes_holdout,
			repetitions, arms_json, budget_json, tolerance_json, stop_rule_json, inference_kind)
			VALUES ('x', 'n', '${NOW}', '[]', 'd', 0, 1, '[]', '{}', '{}', '{}', 'other')`),
		).toThrow();
		expect(db.query("SELECT trial_id FROM lab_trials").all()).toEqual([
			{ trial_id: "old" },
		]);
		// The unique key survived the rebuild, and a live trial is now allowed.
		expect(() => trial("duplicate", "dev")).toThrow(/UNIQUE|constraint/);
		db.exec("UPDATE lab_trials SET repetition = 2");
		trial("now-live", "live");
		expect(db.query("SELECT includes_live FROM lab_experiments").get()).toEqual(
			{
				includes_live: 0,
			},
		);
		expect(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE name = 'lab_trials_by_experiment'",
				)
				.get(),
		).toBeTruthy();
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
