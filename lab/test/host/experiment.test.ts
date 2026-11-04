import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureApprover } from "../../host/approval.ts";
import { runExperiment, type TrialFactories } from "../../host/experiment.ts";
import { createPinoLogger, silentLabLogger } from "../../host/log.ts";
import { MAX_MODEL_CALLS, runPolicy } from "../../host/run.ts";
import { getExperiment, listTrials } from "../../host/store.ts";
import {
	createArm1ScriptedInference,
	loadArm1Script,
} from "../../scripted/arm1.ts";
import { BASE, FakeBrowser } from "./fake-adapter.ts";
import { VERSIONS, devCase, freshDb } from "./harness.ts";
import { report } from "../../cli/report.ts";

describe("experiments", () => {
	test("freezes the experiment, runs the trials in order and aggregates them", async () => {
		const db = freshDb();
		const def = await devCase("dev-search-base");
		const adapters: FakeBrowser[] = [];
		const factories: TrialFactories = {
			adapter: () => {
				const adapter = new FakeBrowser();
				adapters.push(adapter);
				return Promise.resolve({ adapter, dispose: () => Promise.resolve() });
			},
			inference: async (d) => ({
				port: createArm1ScriptedInference(await loadArm1Script(d.id)),
				info: () => ({ kind: "scripted" }),
				dispose: () => Promise.resolve(),
			}),
			approver: (d) => new FixtureApprover(d.approvalScript),
		};
		const done = await runExperiment({
			db,
			cases: [def],
			arms: ["arm1"],
			repetitions: 2,
			name: "t",
			inferenceKind: "scripted",
			includesHoldout: false,
			factories,
			logger: silentLabLogger,
			versions: VERSIONS,
			fixtureBaseUrl: BASE,
		});
		expect(done.results).toHaveLength(2);
		// A session per trial, each closed.
		expect(adapters.map((a) => a.closeCount)).toEqual([1, 1]);
		const experiment = getExperiment(db, done.experimentId)!;
		expect(experiment).toMatchObject({
			caseIds: [def.id],
			repetitions: 2,
			arms: ["arm1"],
			includesHoldout: false,
			inferenceKind: "scripted",
		});
		expect(experiment.caseDigest).toMatch(/^[0-9a-f]{64}$/);
		const trials = listTrials(db, { experimentId: done.experimentId });
		expect(trials.map((t) => [t.repetition, t.orderIndex, t.state])).toEqual([
			[1, 0, "finished"],
			[2, 1, "finished"],
		]);
		const summary = report(db, done.experimentId);
		expect(summary.arms.arm1?.trials).toBe(2);
		expect(summary.arms.arm1?.successRate).toBe(1);
		expect(summary.arms.arm1?.contract.total).toBe(0);
	});

	test("a case past the run limit is refused before anything is stored", async () => {
		const db = freshDb();
		const def = {
			...(await devCase("dev-search-base")),
			budget: { maxModelCalls: MAX_MODEL_CALLS + 1 },
		};
		expect(() => runPolicy(def)).toThrow("case_budget_exceeds_limit");
		await expect(
			runExperiment({
				db,
				cases: [def],
				arms: ["arm1"],
				repetitions: 1,
				name: "t",
				inferenceKind: "scripted",
				includesHoldout: false,
				factories: {} as TrialFactories,
				logger: silentLabLogger,
				versions: VERSIONS,
				fixtureBaseUrl: BASE,
			}),
		).rejects.toThrow("case_budget_exceeds_limit");
		expect(
			db
				.query("SELECT COUNT(*) AS n FROM lab_experiments WHERE id <> 'exp-1'")
				.get(),
		).toEqual({ n: 0 });
	});

	test("every case fits the run limit", async () => {
		const { loadCases } = await import("../../cases/load.ts");
		for (const def of await loadCases({ includeHoldout: true }))
			expect(() => runPolicy(def)).not.toThrow();
	});
});

describe("report", () => {
	test("the success rate is over all trials: an unfinished one is a failure and out of the medians", async () => {
		const db = freshDb();
		const def = await devCase("dev-search-base");
		const { runScripted } = await import("./harness.ts");
		await runScripted("dev-search-base", { db });
		// A second trial that never finished (the process died).
		const { createRun, transitionRun } =
			await import("eumenes-interact/sqlite");
		const { write } = await import("../../host/db.ts");
		const { insertTrial } = await import("../../host/store.ts");
		const nowIso = new Date().toISOString();
		write(db, () => {
			createRun(db, "lab", {
				runId: "run-dead",
				skillRef: "s",
				skillDigest: "d",
				catalogRef: "c",
				catalogDigest: "d",
				platform: "playwright-mcp",
				coreFormatVersion: 1,
				policy: { maxModelCalls: 12, retries: { default: 1 } },
				nowIso,
			});
			transitionRun(db, "lab", "run-dead", "running", { nowIso });
		});
		insertTrial(db, {
			trialId: "t-dead",
			experimentId: "exp-1",
			caseId: def.id,
			split: "dev",
			arm: "arm1",
			platform: "playwright-mcp",
			executionMode: "free",
			knowledge: "none",
			repetition: 2,
			orderIndex: 1,
			runId: "run-dead",
			startedAt: nowIso,
			versions: VERSIONS,
			inference: { kind: "scripted" },
		});
		const arm = report(db, "exp-1").arms.arm1!;
		expect(arm.trials).toBe(2);
		expect(arm.successes).toBe(1);
		expect(arm.successRate).toBe(0.5);
		expect(arm.unfinishedCountedAsFailure).toBe(1);
		// Efficiency medians come from the finished trial only.
		expect(arm.completed).toBe(1);
		expect(arm.medians.modelCalls).toBeGreaterThan(0);
	});
});

describe("logs", () => {
	test("carry correlation ids, fixed codes, counts and durations, and nothing else", () => {
		const dir = mkdtempSync(join(tmpdir(), "interact-log-test-"));
		try {
			const logger = createPinoLogger(dir, "2026-11-03");
			logger.lab("trial.started", { correlationId: "run-1" });
			logger.lab("model.called", {
				correlationId: "run-1",
				code: "text",
				durationMs: 12,
			});
			logger.event("adapter.dispatched", { correlationId: "run-1", count: 1 });
			logger.close();
			const lines = readFileSync(join(dir, "lab-2026-11-03.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			expect(lines).toHaveLength(3);
			for (const line of lines)
				expect(
					Object.keys(line).every((k) =>
						[
							"level",
							"time",
							"event",
							"correlationId",
							"code",
							"count",
							"durationMs",
						].includes(k),
					),
				).toBe(true);
			expect(lines[1]).toMatchObject({
				event: "model.called",
				code: "text",
				durationMs: 12,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
