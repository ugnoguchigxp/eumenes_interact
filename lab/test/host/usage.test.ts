import { describe, expect, test } from "bun:test";
import type { InferencePort } from "eumenes-interact";
import { report, usageReport } from "../../cli/report.ts";
import { aggregateScores } from "../../scorer/aggregate.ts";
import { estimateClaudeCostUsd } from "../../inference/index.ts";
import {
	aggregate,
	buildReport,
	markdown,
	type Sample,
} from "../../host/compare.ts";
import { listTrials } from "../../host/store.ts";
import type { InferenceInfo } from "../../host/types.ts";
import {
	aggregateUsage,
	inferenceLabel,
	trialUsage,
	type TrialUsage,
} from "../../host/usage.ts";
import { TranscriptBuilder } from "../scorer/builder.ts";
import { freshDb, runScripted } from "./harness.ts";

const CLAUDE: InferenceInfo = {
	kind: "claude",
	provider: "anthropic",
	model: "claude-haiku-5-5",
	effort: "low",
};

type Call = {
	input: number | null;
	output: number | null;
	cacheRead?: number | null;
	cacheWrite?: number | null;
};
const transcript = (calls: Call[]) => {
	const b = new TranscriptBuilder();
	for (const tokens of calls) b.call(tokens);
	return b.build("c");
};

describe("a trial's usage", () => {
	test("sums what every call reported, cache included, and prices each call", () => {
		const t = transcript([
			{ input: 1000, output: 100, cacheRead: 0, cacheWrite: 4000 },
			{ input: 200, output: 50, cacheRead: 4000, cacheWrite: 300 },
		]);
		const u = trialUsage(t, CLAUDE);
		expect(u).toMatchObject({
			input: 1200,
			output: 150,
			cacheRead: 4000,
			cacheWrite: 4300,
			modelCalls: 2,
		});
		const each = [
			estimateClaudeCostUsd("claude-haiku-5-5", {
				inputTokens: 1000,
				outputTokens: 100,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 4000,
			}),
			estimateClaudeCostUsd("claude-haiku-5-5", {
				inputTokens: 200,
				outputTokens: 50,
				cacheReadInputTokens: 4000,
				cacheCreationInputTokens: 300,
			}),
		];
		expect(each.every((c) => c !== null && c > 0)).toBe(true);
		expect(u.costUsd).toBeCloseTo(each[0]! + each[1]!, 12);
	});

	test("one call that did not report makes the sum and the cost unknown, never 0", () => {
		const t = transcript([
			{ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
			{ input: null, output: null },
		]);
		expect(trialUsage(t, CLAUDE)).toEqual({
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			promptTotal: null,
			modelCalls: 2,
			costUsd: null,
		});
	});

	test("a provider with no cache reports none: those sums are unknown, the rest are not", () => {
		const u = trialUsage(transcript([{ input: 10, output: 5 }]), {
			kind: "larm",
			profile: "p",
			model: "m",
		});
		expect(u).toMatchObject({
			input: 10,
			output: 5,
			cacheRead: null,
			cacheWrite: null,
		});
		// No price is known for it.
		expect(u.costUsd).toBeNull();
		expect(
			trialUsage(transcript([{ input: 10, output: 5 }]), { kind: "scripted" })
				.costUsd,
		).toBeNull();
	});

	test("an unknown model has no price, and a trial without calls cost nothing", () => {
		const t = transcript([
			{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
		]);
		expect(
			trialUsage(t, { ...CLAUDE, model: "claude-unknown" }).costUsd,
		).toBeNull();
		expect(trialUsage(transcript([]), CLAUDE)).toMatchObject({
			input: 0,
			modelCalls: 0,
			costUsd: 0,
		});
	});

	test("labels group what answered", () => {
		expect(inferenceLabel(CLAUDE)).toBe("claude:claude-haiku-5-5/low");
		expect(inferenceLabel({ kind: "larm", profile: "chat", model: null })).toBe(
			"larm:chat",
		);
		expect(inferenceLabel({ kind: "scripted" })).toBe("scripted");
		expect(inferenceLabel(null)).toBe("unknown");
	});
});

const usage = (over: Partial<TrialUsage>): TrialUsage => ({
	input: 1000,
	output: 100,
	promptTotal: 1000,
	cacheRead: 0,
	cacheWrite: 0,
	modelCalls: 3,
	costUsd: 0.01,
	...over,
});

describe("aggregating usage", () => {
	test("totals over all trials, medians over the completed, success rate over all, cost per trial and per success", () => {
		const row = aggregateUsage([
			{
				success: true,
				usage: usage({ input: 1000, modelCalls: 2, costUsd: 0.01 }),
			},
			{
				success: true,
				usage: usage({ input: 3000, modelCalls: 4, costUsd: 0.03 }),
			},
			{
				success: false,
				usage: usage({ input: 9000, modelCalls: 12, costUsd: 0.06 }),
			},
		]);
		expect(row).toMatchObject({ trials: 3, successes: 2 });
		expect(row.successRate).toBeCloseTo(2 / 3);
		expect(row.tokens.input).toEqual({ total: 13000, median: 2000 });
		expect(row.modelCalls).toEqual({ total: 18, median: 3 });
		expect(row.costUsdEstimate.total).toBeCloseTo(0.1);
		expect(row.costUsdEstimate.perTrial).toBeCloseTo(0.1 / 3);
		// What the failure cost is part of what a success cost.
		expect(row.costUsdEstimate.perSuccess).toBeCloseTo(0.1 / 2);
	});

	test("an unknown value keeps the total unknown but not the medians of the others; unknown cost stays null", () => {
		const row = aggregateUsage([
			{ success: true, usage: usage({ input: 1000, costUsd: 0.01 }) },
			{ success: true, usage: usage({ input: null, costUsd: null }) },
			{ success: true, usage: usage({ input: 3000, costUsd: 0.02 }) },
		]);
		expect(row.tokens.input).toEqual({ total: null, median: 2000 });
		expect(row.costUsdEstimate).toEqual({
			total: null,
			perTrial: null,
			perSuccess: null,
		});
		const none = aggregateUsage([
			{ success: true, usage: usage({ input: null }) },
		]);
		expect(none.tokens.input).toEqual({ total: null, median: null });
	});

	test("no success: no per-success cost; no trial: nothing", () => {
		const failed = aggregateUsage([{ success: false, usage: usage({}) }]);
		expect(failed.costUsdEstimate.perSuccess).toBeNull();
		expect(failed.costUsdEstimate.perTrial).toBeCloseTo(0.01);
		expect(failed.tokens.input.median).toBeNull();
		const empty = aggregateUsage([]);
		expect(empty).toMatchObject({ trials: 0, successRate: null });
		expect(empty.costUsdEstimate.total).toBeNull();
	});
});

/** A model that answers from a list and reports usage with a prompt cache. */
const cachingModel = (texts: string[]): InferencePort => {
	let n = 0;
	return {
		complete: () =>
			Promise.resolve({
				kind: "text",
				text: texts[n++] ?? texts.at(-1)!,
				usage: {
					inputTokens: 500,
					outputTokens: 40,
					cacheReadInputTokens: 2000,
					cacheCreationInputTokens: 100,
				},
				latencyMs: 5,
			}),
	};
};

describe("through a run, the report and the comparison", () => {
	const finish = JSON.stringify({
		action: "finish",
		text: "検索結果を表示しました。",
	});

	const clarify = JSON.stringify({ action: "clarify", text: "どれですか。" });

	test("the transcript carries the cache counters and the score its totals", async () => {
		const { result } = await runScripted("dev-search-base", {
			inference: cachingModel([finish]),
			inferenceInfo: CLAUDE,
		});
		const call = result.transcript.events.find((e) => e.type === "model.call");
		expect(call).toMatchObject({
			tokens: { input: 500, output: 40, cacheRead: 2000, cacheWrite: 100 },
		});
		expect(result.score.efficiency).toMatchObject({
			inputTokens: 500,
			outputTokens: 40,
			cacheReadTokens: 2000,
			cacheWriteTokens: 100,
		});
		// The scripted inference reports no cache: unknown, not 0.
		const scripted = await runScripted("dev-search-base");
		expect(scripted.result.score.efficiency.cacheReadTokens).toBeNull();
		expect(scripted.result.score.efficiency.inputTokens).toBeNull();
		// The medians are over completed trials: a clarify is the right end of the clarify case.
		const done = await runScripted("dev-clarify-form", {
			inference: cachingModel([clarify]),
			inferenceInfo: CLAUDE,
		});
		expect(done.result.score.success).toBe(true);
		expect(aggregateScores([done.result.score]).medians.cacheReadTokens).toBe(
			2000,
		);
	});

	test("report: per platform and inference, overall and per case, with the cost as an estimate", async () => {
		const db = freshDb();
		await runScripted("dev-search-base", {
			db,
			inference: cachingModel([finish]),
			inferenceInfo: CLAUDE,
		});
		await runScripted("dev-clarify-form", {
			db,
			inference: cachingModel([
				JSON.stringify({ action: "clarify", text: "どれですか。" }),
			]),
			inferenceInfo: CLAUDE,
		});
		await runScripted("dev-tab-base", { db });
		const groups = usageReport(listTrials(db, { experimentId: "exp-1" }));
		const claude = groups.find(
			(g) => g.inference === "claude:claude-haiku-5-5/low",
		)!;
		expect(claude.platform).toBe("playwright-mcp");
		expect(claude.overall.trials).toBe(2);
		expect(claude.overall.tokens.input.total).toBe(1000);
		expect(claude.overall.tokens.cacheRead.total).toBe(4000);
		expect(Object.keys(claude.perCase).sort()).toEqual([
			"dev-clarify-form",
			"dev-search-base",
		]);
		expect(
			claude.perCase["dev-search-base"]!.costUsdEstimate.total,
		).toBeGreaterThan(0);
		expect(claude.overall.costUsdEstimate.perTrial).toBeCloseTo(
			claude.overall.costUsdEstimate.total! / 2,
		);
		const scripted = groups.find((g) => g.inference === "scripted")!;
		expect(scripted.overall.tokens.input.total).toBeNull();
		expect(scripted.overall.costUsdEstimate.total).toBeNull();
		expect(report(db, "exp-1").usage).toHaveLength(2);
	});

	test("an unfinished trial counts against the success rate and leaves its tokens unknown", async () => {
		const db = freshDb();
		await runScripted("dev-clarify-form", {
			db,
			inference: cachingModel([clarify]),
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
			VALUES ('t2', 'exp-1', 'dev-clarify-form', 'dev', 'arm0', 'playwright-mcp', 'free', 'none', 2, 1, 'r2', 'x',
				'running', '{}', ?)`,
		).run(JSON.stringify(CLAUDE));
		const [group] = usageReport(listTrials(db));
		expect(group!.overall).toMatchObject({
			trials: 2,
			successes: 1,
			successRate: 0.5,
		});
		expect(group!.overall.tokens.input.total).toBeNull();
		expect(group!.overall.costUsdEstimate.perSuccess).toBeNull();
	});

	test("a free-form request is not a trial of a case: unscored trials stay out of the report", async () => {
		const db = freshDb();
		await runScripted("dev-search-base", {
			db,
			inference: cachingModel([finish]),
			inferenceInfo: CLAUDE,
		});
		db.query("UPDATE lab_trials SET score_json = NULL").run();
		expect(usageReport(listTrials(db))).toEqual([]);
		expect(report(db, "exp-1").unfinishedTrials).toBe(0);
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
		usage: usage({}),
		...over,
	});

	test("the comparison shows tokens, calls and the cost estimate per platform and case, and none for a definition", () => {
		const samples = [
			sample({}),
			sample({ order: 1, usage: usage({ input: 3000, costUsd: 0.03 }) }),
			sample({
				order: 2,
				ok: false,
				status: "failed",
				failures: ["over_budget"],
				usage: usage({ input: null, costUsd: null }),
			}),
			sample({
				order: 3,
				kind: "definition",
				target: "wiki",
				input: { query: "q" },
				inference: null,
				usage: null,
			}),
		];
		const { perTarget, perPlatform } = aggregate(samples);
		const c = perTarget.find((r) => r.target === "c")!;
		expect(c.inference).toBe("claude:claude-haiku-5-5/low");
		expect(c.usage).toMatchObject({ trials: 3, successes: 2 });
		expect(c.usage!.tokens.input).toEqual({ total: null, median: 2000 });
		expect(c.usage!.costUsdEstimate.perSuccess).toBeNull();
		expect(perTarget.find((r) => r.target === "wiki")!.usage).toBeNull();
		expect(perPlatform[0]!.usage!.trials).toBe(3);
		const md = markdown(
			buildReport(
				{
					platforms: ["alpha"],
					repeat: 1,
					headed: false,
					definitions: ["wiki"],
					cases: ["c"],
					inference: "claude:claude-haiku-5-5/low",
				},
				samples.slice(0, 2),
				"2026-11-03T00:00:00.000Z",
			),
		);
		expect(md).toContain("inference: claude:claude-haiku-5-5/low");
		expect(md).toContain("## Tokens and estimated cost");
		expect(md).toContain("estimate from list prices, not a bill");
		expect(md).toContain("uncached input tokens");
		expect(md).toContain("prompt total (input + cache)");
		expect(md).toContain(
			"| alpha | c | claude:claude-haiku-5-5/low | 2 | 100% | 6 / 3 | 4000 / 2000 | 200 / 100 | 0 / 0 | 0 / 0 | 2000 / 1000 | $0.0400 | $0.0200 | $0.0200 |",
		);
		// Nothing to show: no section.
		const plain = markdown(
			buildReport(
				{
					platforms: ["alpha"],
					repeat: 1,
					headed: false,
					definitions: ["wiki"],
					cases: [],
				},
				[samples[3]!],
				"2026-11-03T00:00:00.000Z",
			),
		);
		expect(plain).not.toContain("Tokens and estimated cost");
	});
});
