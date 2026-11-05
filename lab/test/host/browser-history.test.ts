import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadBrowserHistory,
	noBrowserProvedWrong,
	recordMisjudgment,
} from "../../host/browser-history.ts";
import { chainPlan } from "../../host/chain.ts";

const dirs: string[] = [];
const file = () => {
	const d = mkdtempSync(join(tmpdir(), "bh-"));
	dirs.push(d);
	return join(d, "sub", "browser-history.json");
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("browser misjudgment history", () => {
	test("a missing or broken file is no history", () => {
		const p = file();
		expect(loadBrowserHistory(p)).toEqual([]);
		recordMisjudgment(p, { goal: "x", browser: false });
		writeFileSync(p, "{not json");
		expect(loadBrowserHistory(p)).toEqual([]);
	});

	test("records a wrong 'no', replaces the same goal, and keeps only the newest", () => {
		const p = file();
		recordMisjudgment(p, { goal: "最新の順位を教えて", browser: false });
		recordMisjudgment(p, { goal: "最新の順位を教えて", browser: false });
		expect(loadBrowserHistory(p)).toEqual([
			{ goal: "最新の順位を教えて", browser: false, correct: true },
		]);
		for (let i = 0; i < 5; i++)
			recordMisjudgment(p, { goal: `g${i}`, browser: false }, 3);
		expect(loadBrowserHistory(p).map((e) => e.goal)).toEqual([
			"g2",
			"g3",
			"g4",
		]);
	});

	test("an empty or 'not in the results' answer proves 'no browser' wrong", () => {
		expect(noBrowserProvedWrong("")).toBe(true);
		expect(noBrowserProvedWrong("前の結果には順位が含まれていません。")).toBe(
			true,
		);
		expect(noBrowserProvedWrong("最安は 54,099円です。")).toBe(false);
	});

	test("the history reaches the step's signals on an alike goal", () => {
		const req = "価格.comで Switch 2 を検索して、安い順の上位を教えて";
		const plan = chainPlan(req, [
			{ goal: "安い順の上位を教えて", browser: false, correct: true },
		]);
		const s2 = plan.steps[1]!;
		expect(s2.browser.by).toBe("agent");
		expect(s2.browser.signals.pastMisjudged).toHaveLength(1);
		expect(chainPlan(req).steps[1]!.browser.signals.pastMisjudged).toEqual([]);
	});
});
