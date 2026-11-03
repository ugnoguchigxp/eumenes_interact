import { describe, expect, test } from "bun:test";
import { report, usageReport } from "../../cli/report.ts";
import { FixtureApprover } from "../../host/approval.ts";
import {
	aggregate,
	buildReport,
	markdown,
	planCompare,
	runCompare,
} from "../../host/compare.ts";
import { runExperiment, type TrialFactories } from "../../host/experiment.ts";
import { silentLabLogger } from "../../host/log.ts";
import { getExperiment, listTrials } from "../../host/store.ts";
import {
	createArm1ScriptedInference,
	loadArm1Script,
} from "../../scripted/arm1.ts";
import { createScriptedInference } from "../../scripted/inference.ts";
import { loadScript } from "../../scripted/script.ts";
import { BASE, FakeBrowser } from "./fake-adapter.ts";
import { VERSIONS, devCase, freshDb, testCaptureRoot } from "./harness.ts";

/** Arm 0 answers a screenshot request with a finish: it has no tool for it. */
const finisher = createScriptedInference({
	caseId: "x",
	steps: [{ finish: "撮影しました。" }],
});

const factories = (): TrialFactories => ({
	adapter: () =>
		Promise.resolve({
			adapter: new FakeBrowser(),
			dispose: () => Promise.resolve(),
		}),
	inference: async (def, arm) => ({
		port:
			arm === "arm1"
				? createArm1ScriptedInference(await loadArm1Script(def.id))
				: def.id === "dev-clarify-form"
					? createScriptedInference(await loadScript(def.id))
					: finisher,
		info: () => ({ kind: "scripted" }),
		dispose: () => Promise.resolve(),
	}),
	approver: (def) => new FixtureApprover(def.approvalScript),
});

describe("an experiment on Arm 1", () => {
	test("the arm and the output bound are frozen with the experiment, and the report shows them", async () => {
		const db = freshDb();
		const done = await runExperiment({
			db,
			cases: [
				await devCase("dev-capture-results"),
				await devCase("dev-clarify-form"),
			],
			arms: ["arm1"],
			repetitions: 1,
			name: "arm1",
			inferenceKind: "claude",
			frozenInference: {
				model: "claude-haiku-5-5",
				effort: "low",
				maxTokens: 4000,
			},
			includesHoldout: false,
			factories: factories(),
			logger: silentLabLogger,
			versions: VERSIONS,
			fixtureBaseUrl: BASE,
			captureRoot: testCaptureRoot(),
		});
		expect(done.results.map((r) => r.score.success)).toEqual([true, true]);
		const experiment = getExperiment(db, done.experimentId)!;
		expect(experiment.arms).toEqual(["arm1"]);
		expect(experiment.budget.inference).toEqual({
			kind: "claude",
			model: "claude-haiku-5-5",
			effort: "low",
			maxTokens: 4000,
		});
		expect(
			listTrials(db, { experimentId: done.experimentId }).map((t) => t.arm),
		).toEqual(["arm1", "arm1"]);
		const shown = report(db, done.experimentId);
		expect(shown.experiment.frozenArms).toEqual(["arm1"]);
		expect(shown.experiment.inferenceFrozen).toMatchObject({ maxTokens: 4000 });
		expect(shown.arms.arm1).toMatchObject({ trials: 2, successRate: 1 });
		expect(usageReport(listTrials(db)).map((g) => g.arm)).toEqual(["arm1"]);
	});

	test("both arms in one experiment: the screenshot case is a failure of Arm 0 and a success of Arm 1", async () => {
		const db = freshDb();
		const done = await runExperiment({
			db,
			cases: [
				await devCase("dev-capture-results"),
				await devCase("dev-clarify-form"),
			],
			arms: ["arm0", "arm1"],
			repetitions: 1,
			name: "both",
			inferenceKind: "scripted",
			includesHoldout: false,
			factories: factories(),
			logger: silentLabLogger,
			versions: VERSIONS,
			fixtureBaseUrl: BASE,
			captureRoot: testCaptureRoot(),
		});
		const byArm = (arm: string, id: string) =>
			done.results.find(
				(r) => r.transcript.arm === arm && r.transcript.caseId === id,
			)!;
		expect(byArm("arm0", "dev-capture-results").score.success).toBe(false);
		expect(byArm("arm0", "dev-capture-results").score.failures).toContain(
			"capture_missing",
		);
		expect(byArm("arm1", "dev-capture-results").score.success).toBe(true);
		const shown = report(db, done.experimentId);
		expect(shown.arms.arm0).toMatchObject({ trials: 2, successRate: 0.5 });
		expect(shown.arms.arm1).toMatchObject({ trials: 2, successRate: 1 });
	});
});

describe("a comparison on Arm 1", () => {
	test("runs the cases through the parts, freezes the arm and says so in the report", async () => {
		const db = freshDb();
		const cases = [await devCase("dev-capture-results")];
		const samples = await runCompare({
			db,
			logger: silentLabLogger,
			items: planCompare({
				platforms: ["alpha"],
				definitions: [],
				caseIds: cases.map((c) => c.id),
				repeat: 1,
				headed: false,
			}),
			definitions: new Map(),
			cases: new Map(cases.map((c) => [c.id, c])),
			createSession: () =>
				Promise.resolve({
					adapter: new FakeBrowser(),
					dispose: () => Promise.resolve(),
				}),
			fixtureBaseUrl: BASE,
			arm: "arm1",
			captureRoot: testCaptureRoot(),
		});
		expect(samples.map((s) => s.ok)).toEqual([true]);
		const row = db
			.query("SELECT arms_json FROM lab_experiments WHERE id LIKE 'compare-%'")
			.get() as { arms_json: string };
		expect(JSON.parse(row.arms_json)).toEqual(["arm1"]);
		const made = buildReport(
			{
				platforms: ["alpha"],
				repeat: 1,
				headed: false,
				definitions: [],
				cases: cases.map((c) => c.id),
				arm: "arm1",
			},
			samples,
			"2026-11-03T00:00:00.000Z",
		);
		expect(markdown(made)).toContain("arm: arm1");
		expect(aggregate(samples).perTarget.map((r) => r.target)).toContain(
			"dev-capture-results",
		);
	});
});
