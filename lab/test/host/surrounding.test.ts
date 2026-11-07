import { describe, expect, test } from "bun:test";
import { surrounding, withSortControls } from "../../host/parts/executor.ts";

describe("surrounding", () => {
	test("returns the row around a line that is the name alone", () => {
		const text =
			"Jamaica\n\n2025\n\n2,837.08\n\nJapan\n\n2025\n\n123,366.73\n\nJordan";
		const out = surrounding(text, "Japan", 200);
		expect(out).toContain("Japan\n2025\n123,366.73");
	});
	test("falls back to any occurrence, and null when absent", () => {
		expect(surrounding("in Japan today", "Japan", 200)).toContain("in Japan");
		expect(surrounding("nothing here", "Japan", 200)).toBeNull();
	});
});

describe("withSortControls", () => {
	test("does not classify or prioritize candidates by wording", () => {
		const summary = {
			page: "p2",
			url: "https://x/",
			title: "t",
			headings: [],
			regions: [],
			items: [{ item: "p2.i1", role: "link", name: "Home" }],
		};
		const records = [
			{ item: "p2.i1", role: "link", name: "Home" },
			{ item: "p2.i40", role: "link", name: "安い順" },
			{ item: "p2.i41", role: "paragraph", name: "安い順に並べた結果" },
		];
		// biome-ignore lint/suspicious/noExplicitAny: minimal shapes for the test
		const out = withSortControls(summary as any, records as any);
		expect(out.items.map((i) => i.item)).toEqual(["p2.i1"]);
		// biome-ignore lint/suspicious/noExplicitAny: minimal shapes for the test
		expect(withSortControls(summary as any, records.slice(0, 1) as any)).toBe(
			// biome-ignore lint/suspicious/noExplicitAny: minimal shapes for the test
			summary as any,
		);
	});
});
