import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferencePort } from "eumenes-interact";
import { report, usageReport } from "../../cli/report.ts";
import { loadCases } from "../../cases/load.ts";
import {
	aggregate,
	planCompare,
	runCompare,
	type Sample,
} from "../../host/compare.ts";
import { createObservationSink } from "../../host/observations.ts";
import { getExperiment, listTrials } from "../../host/store.ts";
import { OPERATE_CASE_PREFIX, type InferenceInfo } from "../../host/types.ts";
import {
	aggregateUsage,
	noCalls,
	trialUsage,
	UNKNOWN_USAGE,
} from "../../host/usage.ts";
import { aggregateScores } from "../../scorer/aggregate.ts";
import type { TrialScore } from "../../scorer/score.ts";
import type { TranscriptEvent } from "../../scorer/transcript.ts";
import { silentLabLogger } from "../../host/log.ts";
import { TranscriptBuilder } from "../scorer/builder.ts";
import { FakeBrowser } from "./fake-adapter.ts";
import { devCase, freshDb, runScripted } from "./harness.ts";

const CLAUDE: InferenceInfo = {
	kind: "claude",
	provider: "anthropic",
	model: "claude-haiku-5-5",
	effort: "low",
};

/** A Claude-like model: every call reports its tokens, with a cache. */
const claudeLike = (text: string): InferencePort => ({
	complete: () =>
		Promise.resolve({
			kind: "text",
			text,
			usage: {
				inputTokens: 500,
				outputTokens: 40,
				cacheReadInputTokens: 2000,
				cacheCreationInputTokens: 100,
			},
			latencyMs: 5,
		}),
});

describe("the whole prompt, not only the uncached part", () => {
	const b = new TranscriptBuilder()
		.call({ input: 500, output: 40, cacheRead: 2000, cacheWrite: 100 })
		.call({ input: 300, output: 30, cacheRead: 2500, cacheWrite: 0 })
		.build("c");

	test("a trial's prompt total adds the cache reads and writes to Claude's uncached input", () => {
		expect(trialUsage(b, CLAUDE)).toMatchObject({
			input: 800,
			cacheRead: 4500,
			cacheWrite: 100,
			promptTotal: 5400,
		});
	});

	test("an unreported cache counter is no cache use; an unknown input makes the total unknown", () => {
		const plain = new TranscriptBuilder()
			.call({ input: 700, output: 10 })
			.build("c");
		expect(
			trialUsage(plain, { kind: "larm", profile: "p", model: null })
				.promptTotal,
		).toBe(700);
		const unknown = new TranscriptBuilder()
			.call({ input: 700, output: 10 })
			.call({ input: null, output: null })
			.build("c");
		expect(trialUsage(unknown, CLAUDE).promptTotal).toBeNull();
	});

	test("the aggregate has its total and median over the completed trials", () => {
		const row = aggregateUsage([
			{ success: true, usage: { ...noCalls(true), promptTotal: 1000 } },
			{ success: true, usage: { ...noCalls(true), promptTotal: 3000 } },
			{ success: false, usage: { ...noCalls(true), promptTotal: 6000 } },
		]);
		expect(row.tokens.promptTotal).toEqual({ total: 10000, median: 2000 });
	});

	test("the scorer's efficiency has it per trial, and the aggregate a median", async () => {
		const { result } = await runScripted("dev-clarify-form", {
			inference: claudeLike(
				JSON.stringify({ part: "ask", args: { question: "どれですか。" } }),
			),
			inferenceInfo: CLAUDE,
		});
		expect(result.score.efficiency).toMatchObject({
			inputTokens: 500,
			cacheReadTokens: 2000,
			cacheWriteTokens: 100,
			promptTokens: 2600,
		});
		expect(aggregateScores([result.score]).medians.promptTokens).toBe(2600);
	});
});

describe("a score stored before the cache fields existed", () => {
	test("is aggregated without undefined reaching a median", async () => {
		const { result } = await runScripted("dev-clarify-form", {
			inference: claudeLike(
				JSON.stringify({ part: "ask", args: { question: "x" } }),
			),
		});
		const old = JSON.parse(JSON.stringify(result.score)) as TrialScore;
		const efficiency = old.efficiency as unknown as Record<string, unknown>;
		delete efficiency.cacheReadTokens;
		delete efficiency.cacheWriteTokens;
		delete efficiency.promptTokens;
		expect(old.success).toBe(true);
		const agg = aggregateScores([old, result.score]);
		// The new row's values are medians of themselves; the old row adds nothing and breaks nothing.
		expect(agg.medians.cacheReadTokens).toBe(2000);
		expect(agg.medians.promptTokens).toBe(2600);
		const onlyOld = aggregateScores([old]);
		expect(onlyOld.medians.cacheReadTokens).toBeNull();
		expect(onlyOld.medians.cacheWriteTokens).toBeNull();
		expect(onlyOld.medians.promptTokens).toBeNull();
		expect(onlyOld.medians.inputTokens).toBe(500);
	});
});

describe("the comparison freezes what answered", () => {
	test("the experiment of each platform has the real inference kind with the model and effort, and report shows them", async () => {
		const db = freshDb();
		const cases = (await loadCases({ includeHoldout: false })).filter(
			(c) => c.id === "dev-clarify-form",
		);
		await runCompare({
			db,
			logger: silentLabLogger,
			items: planCompare({
				platforms: ["alpha"],
				definitions: [],
				caseIds: ["dev-clarify-form"],
				repeat: 1,
				headed: false,
			}),
			definitions: new Map(),
			cases: new Map(cases.map((c) => [c.id, c])),
			createSession: async () => ({
				adapter: new FakeBrowser(),
				dispose: async () => {},
			}),
			inference: async () => ({
				port: claudeLike(
					JSON.stringify({ part: "ask", args: { question: "x" } }),
				),
				info: () => CLAUDE,
				dispose: async () => {},
			}),
			inferenceKind: "claude",
			frozenInference: { model: "claude-haiku-5-5", effort: "low" },
			inferenceLabel: "claude:claude-haiku-5-5/low",
			fixtureBaseUrl: "http://127.0.0.1:41234/",
		});
		const row = db
			.query("SELECT id FROM lab_experiments WHERE id LIKE 'compare-%'")
			.get() as { id: string };
		const experiment = getExperiment(db, row.id)!;
		expect(experiment.inferenceKind).toBe("claude");
		expect(experiment.budget.inference).toEqual({
			kind: "claude",
			model: "claude-haiku-5-5",
			effort: "low",
		});
		const shown = report(db, row.id);
		expect(shown.experiment.inference).toBe("claude");
		expect(shown.experiment.inferenceFrozen).toEqual({
			kind: "claude",
			model: "claude-haiku-5-5",
			effort: "low",
		});
	});

	test("scripted stays the default, and the run command's experiments freeze the same way", async () => {
		const db = freshDb();
		await runCompare({
			db,
			logger: silentLabLogger,
			items: [],
			definitions: new Map(),
			cases: new Map(),
			createSession: async () => ({
				adapter: new FakeBrowser(),
				dispose: async () => {},
			}),
		});
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM lab_experiments WHERE id LIKE 'compare-%'",
				)
				.get(),
		).toEqual({ n: 0 });
	});
});

const sample = (over: Partial<Sample>): Sample => ({
	order: 0,
	platform: "alpha",
	kind: "case",
	target: "c",
	input: null,
	repetition: 1,
	skipped: null,
	ok: true,
	status: "completed",
	code: null,
	failures: [],
	durationMs: 10,
	observationBytes: [],
	observationRefs: [],
	shapedBytes: [],
	extractChars: [],
	urlUnchanged: 0,
	tool: null,
	preview: null,
	inference: "claude:claude-haiku-5-5/low",
	usage: {
		...noCalls(true),
		input: 1000,
		output: 100,
		promptTotal: 1000,
		modelCalls: 3,
		costUsd: 0.01,
	},
	...over,
});

describe("the success rate of the usage table is the main table's", () => {
	test("a case that never started is a failed trial with no calls and no cost, in the denominator", () => {
		const samples = [
			sample({ order: 0 }),
			sample({ order: 1 }),
			sample({ order: 2 }),
			sample({
				order: 3,
				ok: false,
				status: "error",
				code: "session_unavailable",
				failures: ["session_unavailable"],
				usage: noCalls(true),
			}),
			sample({
				order: 4,
				ok: false,
				status: "error",
				code: "session_unavailable",
				failures: ["session_unavailable"],
				usage: noCalls(true),
			}),
		];
		const { perTarget } = aggregate(samples);
		const row = perTarget[0]!;
		expect(row.okRate).toBeCloseTo(0.6);
		expect(row.usage!.trials).toBe(5);
		expect(row.usage!.successRate).toBeCloseTo(0.6);
		expect(row.usage!.modelCalls.total).toBe(9);
		expect(row.usage!.costUsdEstimate.total).toBeCloseTo(0.03);
		expect(row.usage!.costUsdEstimate.perSuccess).toBeCloseTo(0.01);
	});

	test("a case sample without usage counts too, as unknown, and a definition has none", () => {
		const { perTarget } = aggregate([
			sample({ order: 0 }),
			sample({ order: 1, ok: false, usage: null }),
			sample({
				order: 2,
				kind: "definition",
				target: "d",
				input: { query: "q" },
				usage: null,
				inference: null,
			}),
		]);
		const c = perTarget.find((r) => r.target === "c")!;
		expect(c.usage!.trials).toBe(2);
		expect(c.usage!.successRate).toBe(0.5);
		expect(c.usage!.tokens.input.total).toBeNull();
		expect(c.usage!.modelCalls.total).toBeNull();
		expect(perTarget.find((r) => r.target === "d")!.usage).toBeNull();
	});

	test("a session that could not start is that kind of sample, end to end", async () => {
		const db = freshDb();
		const samples = await runCompare({
			db,
			logger: silentLabLogger,
			items: planCompare({
				platforms: ["alpha"],
				definitions: [],
				caseIds: ["dev-clarify-form"],
				repeat: 2,
				headed: false,
			}),
			definitions: new Map(),
			cases: new Map(),
			createSession: () => Promise.reject(new Error("no browser")),
			inferenceLabel: "claude:claude-haiku-5-5/low",
		});
		expect(samples.map((s) => [s.code, s.usage])).toEqual([
			["session_unavailable", noCalls(true)],
			["session_unavailable", noCalls(true)],
		]);
		expect(aggregate(samples).perTarget[0]!.usage).toMatchObject({
			trials: 2,
			successRate: 0,
		});
	});
});

describe("the report", () => {
	const finish = JSON.stringify({ part: "ask", args: { question: "x" } });

	test("a trial with no transcript has an unknown number of model calls, not 0", async () => {
		expect(UNKNOWN_USAGE.modelCalls).toBeNull();
		const db = freshDb();
		await runScripted("dev-clarify-form", {
			db,
			inference: claudeLike(finish),
			inferenceInfo: CLAUDE,
		});
		db.query(
			`INSERT INTO interact_runs (run_id, owner, status, skill_ref, skill_digest, catalog_ref, catalog_digest, platform,
				core_format_version, policy_json, created_at, updated_at)
			VALUES ('r2', 'lab', 'running', 's', 'd', 'c', 'd', 'playwright-mcp', 1, '{"maxModelCalls":12,"retries":{}}', 'x', 'x')`,
		).run();
		db.query(
			`INSERT INTO lab_trials (trial_id, experiment_id, case_id, split, arm, platform, execution_mode, knowledge,
				repetition, order_index, run_id, started_at, state, versions_json, inference_json)
			VALUES ('t2', 'exp-1', 'dev-clarify-form', 'dev', 'arm1', 'playwright-mcp', 'free', 'none', 2, 1, 'r2', 'x', 'running', '{}', ?)`,
		).run(JSON.stringify(CLAUDE));
		const [g] = usageReport(listTrials(db));
		expect(g!.overall.modelCalls.total).toBeNull();
		expect(g!.overall).toMatchObject({ trials: 2, successes: 1 });
	});

	test("an interrupted free-form (operate) trial is not a failed trial of a case", async () => {
		const db = freshDb();
		await runScripted("dev-clarify-form", {
			db,
			inference: claudeLike(finish),
			inferenceInfo: CLAUDE,
		});
		db.query(
			`INSERT INTO interact_runs (run_id, owner, status, skill_ref, skill_digest, catalog_ref, catalog_digest, platform,
				core_format_version, policy_json, created_at, updated_at)
			VALUES ('r3', 'lab', 'running', 's', 'd', 'c', 'd', 'playwright-mcp', 1, '{"maxModelCalls":12,"retries":{}}', 'x', 'x')`,
		).run();
		db.query(
			`INSERT INTO lab_trials (trial_id, experiment_id, case_id, split, arm, platform, execution_mode, knowledge,
				repetition, order_index, run_id, started_at, state, versions_json, inference_json)
			VALUES ('t3', 'exp-1', ?, 'live', 'arm1', 'playwright-mcp', 'free', 'none', 5, 2, 'r3', 'x', 'interrupted', '{}', ?)`,
		).run(`${OPERATE_CASE_PREFIX}abc`, JSON.stringify(CLAUDE));
		const groups = usageReport(listTrials(db));
		expect(groups).toHaveLength(1);
		expect(groups[0]!.overall.trials).toBe(1);
		expect(Object.keys(groups[0]!.perCase)).toEqual(["dev-clarify-form"]);
		const shown = report(db, "exp-1");
		expect(shown.unfinishedTrials).toBe(0);
		expect(shown.arms.arm1!.trials).toBe(1);
	});
});

describe("a real site's stored record keeps no page-derived text", () => {
	const finishText = JSON.stringify({
		part: "done",
		args: {
			answer: "ページにはこう書いてありました。",
			evidence: ["r1"],
			outcome: "achieved",
			basis: "observed",
		},
	});
	const finishingInference = (): InferencePort => {
		let first = true;
		return {
			complete: (request) => {
				const text = first
					? JSON.stringify({
							part: "page.read",
							args: { target: null, maxChars: 2000 },
						})
					: finishText;
				first = false;
				return claudeLike(text).complete(request);
			},
		};
	};
	const finalOf = (events: readonly TranscriptEvent[]) =>
		events.filter((e) => e.type === "step.final").at(-1);

	test("a live run without kept observations records the kind and the text's length only; a listener sees the text", async () => {
		const live = (
			await loadCases({ includeHoldout: false, includeLive: true })
		).find((c) => c.split === "live")!;
		const seen: TranscriptEvent[] = [];
		const { result, db } = await runScripted(live.id, {
			def: live,
			inference: finishingInference(),
			onEvent: (e) => void seen.push(e),
		});
		const stored = finalOf(result.transcript.events);
		expect(stored).toMatchObject({
			type: "step.final",
			kind: "finish",
			textLength: "ページにはこう書いてありました。".length,
		});
		expect(stored).not.toHaveProperty("text");
		const row = db.query("SELECT transcript_json FROM lab_trials").get() as {
			transcript_json: string;
		};
		expect(row.transcript_json).not.toContain("ページにはこう");
		expect(finalOf(seen)).toMatchObject({
			kind: "finish",
			text: "ページにはこう書いてありました。",
		});
		// The listener's event is not the stored one.
		expect(finalOf(seen)).not.toBe(stored);
	});

	test("with kept observations, and for a fixture, the text stays (the scorer reads it)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "interact-keep-test-"));
		try {
			const live = (
				await loadCases({ includeHoldout: false, includeLive: true })
			).find((c) => c.split === "live")!;
			const kept = await runScripted(live.id, {
				def: live,
				inference: finishingInference(),
				observationSink: createObservationSink(dir),
			});
			expect(finalOf(kept.result.transcript.events)).toMatchObject({
				text: "ページにはこう書いてありました。",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const fixture = await runScripted("dev-clarify-form");
		expect(finalOf(fixture.result.transcript.events)).toMatchObject({
			kind: "clarify",
		});
		expect(finalOf(fixture.result.transcript.events)).toHaveProperty("text");
		const info = await devCase("dev-clarify-form");
		expect(info.split).toBe("dev");
	});
});
