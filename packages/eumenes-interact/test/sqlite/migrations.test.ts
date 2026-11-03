import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { PLATFORM_IDS } from "../../src/contracts/common.ts";
import { OPERATION_STATUSES } from "../../src/contracts/operation.ts";
import {
	INTERACT_TABLES,
	RUN_STATUSES,
	assertInteractSchema,
	isInteractStoreError,
	migrations,
} from "../../src/sqlite/index.ts";
import { NOW, openDb } from "./support.ts";

const FAKE_DIGEST = "d";

function seedRows(db: Database) {
	db.exec(`
		INSERT INTO interact_site_scopes (id, owner, origin, created_at)
			VALUES (1, 'o', 'https://a.example', '${NOW}'), (2, 'o', 'https://b.example', '${NOW}');
		INSERT INTO interact_page_profiles (id, scope_id, name, conditions_json, created_at, updated_at)
			VALUES (1, 1, 'home', '{}', '${NOW}', '${NOW}');
		INSERT INTO interact_runs (run_id, owner, status, skill_ref, skill_digest, catalog_ref,
			catalog_digest, platform, core_format_version, policy_json, created_at, updated_at)
			VALUES ('r1', 'o', 'running', 's', 'd', 'c', 'd', 'playwright-mcp', 1, '{}', '${NOW}', '${NOW}');
	`);
}

function insertRun(db: Database, status: string, platform = "playwright-mcp") {
	db.query(
		`INSERT INTO interact_runs (run_id, owner, status, skill_ref, skill_digest, catalog_ref,
			catalog_digest, platform, core_format_version, policy_json, created_at, updated_at, finished_at)
		VALUES (?, 'o', ?, 's', 'd', 'c', 'd', ?, 1, '{}', ?, ?, ?)`,
	).run(
		`run-${status}-${platform}`,
		status,
		platform,
		NOW,
		NOW,
		["queued", "running", "needs_input"].includes(status) ? null : NOW,
	);
}

describe("migrations", () => {
	test("apply to an empty database in order and are the only SQL", () => {
		expect(migrations.length).toBeGreaterThan(0);
		const db = new Database(":memory:");
		for (const sql of migrations) db.exec(sql);
		const tables = db
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'interact_%'",
			)
			.all() as { name: string }[];
		expect(tables.map((t) => t.name).sort()).toEqual(
			[...INTERACT_TABLES].sort(),
		);
	});

	test("do not touch tables outside the interact_ prefix", () => {
		const db = new Database(":memory:");
		for (const sql of migrations) db.exec(sql);
		const names = db
			.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
			.all() as { name: string }[];
		for (const { name } of names)
			expect(name.startsWith("interact_")).toBe(true);
	});

	test("assertInteractSchema accepts the migrated database and refuses an empty one", () => {
		assertInteractSchema(openDb());
		try {
			assertInteractSchema(new Database(":memory:"));
			throw new Error("expected a store error");
		} catch (error) {
			expect(isInteractStoreError(error)).toBe(true);
			expect((error as { code: string }).code).toBe("schema_missing");
		}
	});

	test("a missing table is reported", () => {
		const db = openDb();
		db.exec("DROP TABLE interact_plan_revisions");
		expect(() => assertInteractSchema(db)).toThrow("schema_missing");
	});
});

describe("CHECK enums match the contract vocabularies", () => {
	test("run statuses", () => {
		const db = openDb();
		for (const status of RUN_STATUSES) insertRun(db, status);
		expect(() => insertRun(db, "paused")).toThrow();
	});

	test("platforms", () => {
		const db = openDb();
		for (const platform of PLATFORM_IDS) insertRun(db, "queued", platform);
		expect(() => insertRun(db, "queued", "selenium")).toThrow();
	});

	test("operation statuses, effects and candidate sources", () => {
		const db = openDb();
		seedRows(db);
		let seq = 0;
		const insertOperation = (status: string, effect = "none") => {
			seq += 1;
			const settled = ["confirmed", "failed", "indeterminate"].includes(status);
			db.query(
				`INSERT INTO interact_operations (operation_id, run_id, seq, status, action, session_id,
					generation, declared_effect, command_json, created_at, dispatched_at, settled_at)
				VALUES (?, 'r1', ?, ?, 'page.click', 's', 0, ?, '{}', ?, ?, ?)`,
			).run(
				`op-${seq}`,
				seq,
				status,
				effect,
				NOW,
				status === "not_dispatched" ? null : NOW,
				settled ? NOW : null,
			);
		};
		for (const status of OPERATION_STATUSES) insertOperation(status);
		expect(() => insertOperation("sent")).toThrow();
		expect(() => insertOperation("not_dispatched", "delete")).toThrow();
	});
});

describe("constraints", () => {
	test("origin must be a bare lowercase http(s) origin", () => {
		const db = openDb();
		const insert = (origin: string) =>
			db
				.query(
					"INSERT INTO interact_site_scopes (owner, origin, created_at) VALUES ('o', ?, ?)",
				)
				.run(origin, NOW);
		insert("https://a.example");
		insert("http://localhost:8080");
		for (const bad of [
			"ftp://a.example",
			"https://user:pw@a.example",
			"https://a.example/path",
			"https://a.example?x=1",
			"https://A.example",
			"a.example",
			"https://",
		]) {
			expect(() => insert(bad)).toThrow();
		}
	});

	test("foreign keys: an operation needs its run, an object needs a profile of its own scope", () => {
		const db = openDb();
		seedRows(db);
		const insertOperation = (runId: string) =>
			db
				.query(
					`INSERT INTO interact_operations (operation_id, run_id, seq, action, session_id, generation,
						declared_effect, command_json, created_at)
					VALUES ('x', ?, 1, 'page.click', 's', 0, 'none', '{}', ?)`,
				)
				.run(runId, NOW);
		expect(() => insertOperation("missing")).toThrow();
		insertOperation("r1");
		const insertObject = (scope: number) =>
			db
				.query(
					`INSERT INTO interact_site_objects (scope_id, page_profile_id, logical_name, revision,
						created_at, updated_at) VALUES (?, 1, 'search.query', 1, ?, ?)`,
				)
				.run(scope, NOW, NOW);
		// Profile 1 belongs to scope 1: scope 2 would let one origin borrow another's profile.
		expect(() => insertObject(2)).toThrow();
		insertObject(1);
	});

	test("a logical name is unique inside a page profile only", () => {
		const db = openDb();
		seedRows(db);
		db.exec(
			`INSERT INTO interact_page_profiles (id, scope_id, name, conditions_json, created_at, updated_at)
				VALUES (2, 2, 'home', '{}', '${NOW}', '${NOW}')`,
		);
		const insert = (scope: number, profile: number) =>
			db
				.query(
					`INSERT INTO interact_site_objects (scope_id, page_profile_id, logical_name, revision,
						created_at, updated_at) VALUES (?, ?, 'search.query', 1, ?, ?)`,
				)
				.run(scope, profile, NOW, NOW);
		insert(1, 1);
		insert(2, 2);
		expect(() => insert(1, 1)).toThrow();
	});

	test("candidates need a known kind, adapter and a bounded via; JSON must be an object", () => {
		const db = openDb();
		seedRows(db);
		db.exec(
			`INSERT INTO interact_site_objects (id, scope_id, page_profile_id, logical_name, revision, created_at, updated_at)
				VALUES (1, 1, 1, 'search.query', 1, '${NOW}', '${NOW}')`,
		);
		const insert = (
			kind: string,
			fields: string,
			adapter: string,
			via: string,
		) =>
			db
				.query(
					`INSERT INTO interact_locator_candidates (object_id, kind, fields_json, status_changed_at,
						source_adapter, source_via, added_revision, created_at)
					VALUES (1, ?, ?, ?, ?, ?, 1, ?)`,
				)
				.run(kind, fields, NOW, adapter, via, NOW);
		insert("role", '{"role":"searchbox"}', "playwright-mcp", "snapshot");
		expect(() =>
			insert("css", '{"a":1}', "playwright-mcp", "snapshot"),
		).toThrow();
		expect(() => insert("role", '{"a":1}', "selenium", "snapshot")).toThrow();
		expect(() => insert("role", '{"a":1}', "playwright-mcp", "")).toThrow();
		expect(() => insert("role", '{"a":1}', "playwright-mcp", "a b")).toThrow();
		expect(() => insert("role", "[1]", "playwright-mcp", "snapshot")).toThrow();
		expect(() =>
			insert("role", "not json", "playwright-mcp", "snapshot"),
		).toThrow();
	});

	test("a run's workflow columns come together and the revision must exist", () => {
		const db = openDb();
		const insert = (id: string, rev: number | null, digest: string | null) =>
			db
				.query(
					`INSERT INTO interact_runs (run_id, owner, status, workflow_id, workflow_revision, definition_digest,
						skill_ref, skill_digest, catalog_ref, catalog_digest, platform, core_format_version,
						policy_json, created_at, updated_at)
					VALUES (?, 'o', 'queued', ?, ?, ?, 's', 'd', 'c', 'd', 'playwright-mcp', 1, '{}', ?, ?)`,
				)
				.run(id, rev === null ? null : "wf", rev, digest, NOW, NOW);
		expect(() => insert("a", 1, FAKE_DIGEST)).toThrow();
		expect(() => insert("b", 1, null)).toThrow();
		insert("c", null, null);
	});

	test("a finished run needs finished_at and an unfinished run must not have it", () => {
		const db = openDb();
		const insert = (status: string, finished: string | null) =>
			db
				.query(
					`INSERT INTO interact_runs (run_id, owner, status, skill_ref, skill_digest, catalog_ref,
						catalog_digest, platform, core_format_version, policy_json, created_at, updated_at, finished_at)
					VALUES (?, 'o', ?, 's', 'd', 'c', 'd', 'playwright-mcp', 1, '{}', ?, ?, ?)`,
				)
				.run(`r-${status}-${finished}`, status, NOW, NOW, finished);
		expect(() => insert("completed", null)).toThrow();
		expect(() => insert("running", NOW)).toThrow();
	});

	test("operation settle columns agree with the status", () => {
		const db = openDb();
		seedRows(db);
		const insert = (
			status: string,
			dispatched: string | null,
			settled: string | null,
		) =>
			db
				.query(
					`INSERT INTO interact_operations (operation_id, run_id, seq, status, action, session_id,
						generation, declared_effect, command_json, created_at, dispatched_at, settled_at)
					VALUES (?, 'r1', ?, ?, 'page.click', 's', 0, 'none', '{}', ?, ?, ?)`,
				)
				.run(
					`o-${status}-${dispatched}-${settled}`,
					Math.random() * 1e9,
					status,
					NOW,
					dispatched,
					settled,
				);
		expect(() => insert("confirmed", NOW, null)).toThrow();
		expect(() => insert("dispatched", NOW, NOW)).toThrow();
		expect(() => insert("confirmed", null, NOW)).toThrow();
		expect(() => insert("dispatched", null, null)).toThrow();
		insert("failed", null, NOW);
	});
});

describe("immutability triggers", () => {
	test("a finished run and a settled operation cannot be updated; a workflow revision never", () => {
		const db = openDb();
		seedRows(db);
		db.exec(
			`INSERT INTO interact_workflows (owner, workflow_id, created_at) VALUES ('o', 'wf', '${NOW}');
			INSERT INTO interact_workflow_revisions (owner, workflow_id, revision, format_version, digest,
				skill_ref, catalog_ref, definition_json, created_at)
				VALUES ('o', 'wf', 1, 1, 'd', 's', 'c', '{}', '${NOW}');
			INSERT INTO interact_operations (operation_id, run_id, seq, status, action, session_id, generation,
				declared_effect, command_json, created_at, dispatched_at, settled_at)
				VALUES ('op', 'r1', 1, 'confirmed', 'page.click', 's', 0, 'none', '{}', '${NOW}', '${NOW}', '${NOW}')`,
		);
		expect(() =>
			db.exec("UPDATE interact_workflow_revisions SET digest = 'x'"),
		).toThrow("interact_immutable");
		expect(() =>
			db.exec("UPDATE interact_operations SET status = 'failed'"),
		).toThrow("interact_immutable");
		db.exec(
			`UPDATE interact_runs SET status = 'completed', finished_at = '${NOW}'`,
		);
		expect(() =>
			db.exec(
				"UPDATE interact_runs SET status = 'running', finished_at = NULL",
			),
		).toThrow("interact_immutable");
	});
});
