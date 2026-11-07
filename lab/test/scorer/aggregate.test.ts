import { describe, expect, test } from "bun:test";
import { aggregateScores, median } from "../../scorer/aggregate.ts";
import { scoreTrial, type TrialScore } from "../../scorer/score.ts";
import { TranscriptBuilder, click, devCase, fixtureUrl } from "./builder.ts";
import type { TokenUsage } from "../../scorer/transcript.ts";

const page = "sites/hoshikuzu/base/book.html?id=4";

/** A dev-update-base trial: successful or not, with the given tokens per model call. */
async function trial(
	success: boolean,
	tokens: TokenUsage[],
	extra: (b: TranscriptBuilder) => void = () => {},
): Promise<TrialScore> {
	const def = await devCase("dev-update-base");
	const b = new TranscriptBuilder();
	for (const t of tokens) b.call(t);
	extra(b);
	b.step("op", click("e3"), fixtureUrl(success ? `${page}#stock` : page)).final(
		"finish",
		"在庫は2冊です",
	);
	return scoreTrial(def, b.build(def.id));
}

describe("median", () => {
	test("odd, even and empty", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([])).toBeNull();
	});
});

describe("aggregateScores", () => {
	test("success rate is over all trials; medians are over completed ones", async () => {
		const scores = [
			await trial(true, [{ input: 10, output: 1 }]),
			await trial(true, [
				{ input: 10, output: 1 },
				{ input: 10, output: 1 },
				{ input: 10, output: 1 },
			]),
			await trial(false, [{ input: 5000, output: 500 }]),
			await trial(false, [{ input: 5000, output: 500 }]),
		];
		const agg = aggregateScores(scores);
		expect(agg.trials).toBe(4);
		expect(agg.successRate).toBe(0.5);
		expect(agg.completed).toBe(2);
		expect(agg.medians.modelCalls).toBe(2);
		expect(agg.medians.inputTokens).toBe(20);
		expect(agg.falseFinish).toBe(2);
	});

	test("unknown tokens are left out of the medians and counted", async () => {
		const scores = [
			await trial(true, [{ input: 100, output: 10 }]),
			await trial(true, [{ input: null, output: 10 }]),
			await trial(true, [{ input: 300, output: null }]),
		];
		const agg = aggregateScores(scores);
		expect(agg.medians.inputTokens).toBe(200);
		expect(agg.medians.outputTokens).toBe(10);
		expect(agg.tokensUnknownTrials).toEqual({ input: 1, output: 1 });
	});

	test("contract counters are sums, not averages, and recovery is a rate over disrupted trials", async () => {
		const clean = await trial(true, [{ input: 1, output: 1 }]);
		const scoped = await trial(true, [{ input: 1, output: 1 }], (b) =>
			b.observe("https://www.example.com/"),
		);
		const failedThenOk = await trial(true, [{ input: 1, output: 1 }], (b) =>
			b
				.request("pre", click("e1"))
				.dispatch("pre")
				.result("pre", { status: "failed", code: "stale_ref" }),
		);
		const agg = aggregateScores([clean, scoped, failedThenOk]);
		expect(agg.contract.scopeViolations).toBe(1);
		expect(agg.contract.total).toBe(1);
		expect(agg.contract.trialsWithViolation).toBe(1);
		expect(agg.recovery).toEqual({ disrupted: 1, recovered: 1, rate: 1 });
	});

	test("an empty set has no rates", () => {
		const agg = aggregateScores([]);
		expect(agg.successRate).toBeNull();
		expect(agg.medians.totalMs).toBeNull();
		expect(agg.recovery.rate).toBeNull();
		expect(agg.completion).toEqual({
			assessed: 0,
			goalStateAchieved: 0,
			excessPartial: 0,
		});
		expect(agg.captures.assessed).toBe(0);
	});
});
