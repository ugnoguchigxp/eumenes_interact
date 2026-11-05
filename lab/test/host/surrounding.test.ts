import { describe, expect, test } from "bun:test";
import { surrounding } from "../../host/parts/executor.ts";

describe("surrounding", () => {
	test("returns the row around a line that is the name alone", () => {
		const text = "Jamaica\n\n2025\n\n2,837.08\n\nJapan\n\n2025\n\n123,366.73\n\nJordan";
		const out = surrounding(text, "Japan", 200);
		expect(out).toContain("Japan\n2025\n123,366.73");
	});
	test("falls back to any occurrence, and null when absent", () => {
		expect(surrounding("in Japan today", "Japan", 200)).toContain("in Japan");
		expect(surrounding("nothing here", "Japan", 200)).toBeNull();
	});
});
