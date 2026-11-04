import { describe, expect, test } from "bun:test";
import { decideSession } from "eumenes-collaboration";
import {
	chainCases,
	holdSession,
	holdUntil,
	planSteps,
	stepRequest,
} from "../../host/chain.ts";
import { FakeBrowser } from "./fake-adapter.ts";

const MSFT =
	"Google FinanceでMSFTの株価と最新ニュースを調べて、YouTubeで関連する動画を探して再生して、最後にサマリーを教えて";

async function* feed(lines: string[], gapMs = 5) {
	for (const l of lines) {
		await new Promise((r) => setTimeout(r, gapMs));
		yield l;
	}
	await new Promise(() => {});
}

describe("chain (2026-11-04)", () => {
	test("each browser step starts on the site it names; the summary has no browser", () => {
		const plan = planSteps(MSFT, "request");
		const cases = chainCases(plan, MSFT, new Map(), 10);
		expect(cases.map((c) => c.def?.start ?? null)).toEqual([
			"https://www.google.com/finance/",
			"https://www.youtube.com/",
			null,
		]);
		expect(cases[1]!.step.keepOpen).toBe(true);
		expect(cases[0]!.def!.allowedOrigins).toContain("https://www.google.com");
	});
	test("a later step is given the earlier verified results as data", () => {
		const plan = planSteps(MSFT, "request");
		const text = stepRequest(
			plan.steps[1]!,
			MSFT,
			new Map([["s1", "MSFT 500 USD; news: Azure"]]),
		);
		expect(text).toContain("[s1] MSFT 500 USD; news: Azure");
		expect(text.startsWith(plan.steps[1]!.goal)).toBe(true);
	});
	test("a step that names no site and has none before it is refused, not guessed", () => {
		const plan = planSteps("どこかで猫を探して", "request");
		expect(() => chainCases(plan, "x", new Map(), 10)).toThrow(
			"step_site_unknown",
		);
	});
	test("a held session is opened once and only release closes it", async () => {
		const inner = new FakeBrowser();
		let opens = 0;
		let closes = 0;
		const open = inner.open.bind(inner);
		inner.open = () => {
			opens += 1;
			return open();
		};
		inner.close = async () => {
			closes += 1;
		};
		const hold = holdSession(inner);
		await hold.adapter.open(AbortSignal.timeout(1000));
		await hold.adapter.open(AbortSignal.timeout(1000));
		await hold.adapter.close();
		expect([opens, closes]).toEqual([1, 0]);
		await hold.release();
		expect(closes).toBe(1);
	});
	test("the kept browser closes on 完了, not on thanks, and on the idle timeout", async () => {
		const done = (l: string) => decideSession(l, false).decision === "close";
		expect(await holdUntil(feed(["ありがとう", "完了"]), done, 1000)).toBe(
			"user_done",
		);
		expect(await holdUntil(feed(["ありがとう"]), done, 50)).toBe(
			"idle_timeout",
		);
	});
});
