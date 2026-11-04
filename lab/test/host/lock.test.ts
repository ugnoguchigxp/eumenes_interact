import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRun,
	getOperation,
	getRun,
	markOperationDispatched,
	recordOperationIntent,
	transitionRun,
} from "eumenes-interact/sqlite";
import { openLabDb, write } from "../../host/db.ts";
import {
	RunnerActiveError,
	acquireRunLock,
	processAlive,
	runnerAlive,
} from "../../host/lock.ts";
import { LAB_OWNER } from "../../host/run.ts";
import { insertTrial, createExperiment } from "../../host/store.ts";
import { VERSIONS } from "./harness.ts";

let dir = "";
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "interact-lock-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the single-runner lock", () => {
	test("a second runner is refused while the lock is held, and may start after release", () => {
		const path = join(dir, "a.lock");
		const first = acquireRunLock(path);
		expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
		expect(() => acquireRunLock(path)).toThrow(RunnerActiveError);
		first.release();
		expect(existsSync(path)).toBe(false);
		acquireRunLock(path).release();
	});

	test("a stale lock (its pid is gone) is recovered", () => {
		const path = join(dir, "b.lock");
		writeFileSync(path, "999999\n");
		const lock = acquireRunLock(path, () => false, 4242);
		expect(readFileSync(path, "utf8").trim()).toBe("4242");
		lock.release();
		expect(existsSync(path)).toBe(false);
	});

	test("an unreadable lock file counts as stale; a live owner is never taken over", () => {
		const path = join(dir, "c.lock");
		writeFileSync(path, "not a pid");
		acquireRunLock(path, () => true).release();
		writeFileSync(path, "123\n");
		expect(() => acquireRunLock(path, () => true)).toThrow(RunnerActiveError);
		expect(readFileSync(path, "utf8").trim()).toBe("123");
	});

	test("release removes only the owner's own lock", () => {
		const path = join(dir, "d.lock");
		const mine = acquireRunLock(path, () => false, 1111);
		writeFileSync(path, "2222\n");
		mine.release();
		expect(readFileSync(path, "utf8").trim()).toBe("2222");
	});

	test("a live pid that is not a runner (pid reused after a crash) leaves a stale lock", () => {
		const path = join(dir, "reused.lock");
		const other = Bun.spawn(["sleep", "30"]);
		try {
			writeFileSync(path, `${other.pid}\n`);
			expect(runnerAlive(other.pid)).toBe(false);
			expect(runnerAlive(process.pid)).toBe(true);
			const lock = acquireRunLock(path);
			expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
			lock.release();
		} finally {
			other.kill();
		}
	});

	test("this process is alive", () => {
		expect(processAlive(process.pid)).toBe(true);
	});
});

describe("read-only commands", () => {
	test("cases, trials and report leave another runner's rows alone and take no lock", () => {
		const path = join(dir, "interact.sqlite");
		const nowIso = new Date().toISOString();
		const db = openLabDb(path);
		createExperiment(db, {
			id: "exp-1",
			name: "t",
			caseIds: [],
			caseDigest: "d",
			includesHoldout: false,
			repetitions: 1,
			arms: ["arm1"],
			budget: {},
			inferenceKind: "scripted",
			nowIso,
		});
		write(db, () => {
			createRun(db, LAB_OWNER, {
				runId: "run-live",
				skillRef: "s",
				skillDigest: "d",
				catalogRef: "c",
				catalogDigest: "d",
				platform: "playwright-mcp",
				coreFormatVersion: 1,
				policy: { maxModelCalls: 12, retries: { default: 1 } },
				nowIso,
			});
			transitionRun(db, LAB_OWNER, "run-live", "running", { nowIso });
			recordOperationIntent(db, LAB_OWNER, "run-live", {
				request: {
					operationId: "op-live",
					sessionId: "s",
					generation: 0,
					command: { action: "browser.back" },
					declaredEffect: "navigation",
				},
				nowIso,
			});
			markOperationDispatched(db, LAB_OWNER, "op-live", nowIso);
		});
		insertTrial(db, {
			trialId: "t-live",
			experimentId: "exp-1",
			caseId: "dev-search-base",
			split: "dev",
			arm: "arm1",
			platform: "playwright-mcp",
			executionMode: "free",
			knowledge: "none",
			repetition: 1,
			orderIndex: 0,
			runId: "run-live",
			startedAt: nowIso,
			versions: VERSIONS,
			inference: { kind: "scripted" },
		});
		db.close();
		const main = join(import.meta.dir, "../../cli/main.ts");
		for (const args of [
			["cases"],
			["trials"],
			["trials", "--experiment", "exp-1"],
			["report", "--experiment", "exp-1"],
		]) {
			const done = Bun.spawnSync(["bun", main, ...args, "--db", path], {
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(done.exitCode).toBe(0);
			expect(done.stderr.toString()).not.toContain("reconciled");
		}
		expect(existsSync(`${path}.run.lock`)).toBe(false);
		const after = openLabDb(path);
		expect(getRun(after, LAB_OWNER, "run-live")?.status).toBe("running");
		expect(getOperation(after, LAB_OWNER, "op-live")?.status).toBe(
			"dispatched",
		);
		expect(
			after
				.query("SELECT state FROM lab_trials WHERE trial_id = 't-live'")
				.get(),
		).toEqual({ state: "running" });
		after.close();
	});
});
