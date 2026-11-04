import { describe, expect, test } from "bun:test";
import { capKeepingSide } from "../../../src/adapters/mcp/extract.ts";

describe("capKeepingSide", () => {
	test("keeps the side block when the main text is cut", () => {
		const text = `${"a".repeat(5000)}\n\n[side]\nLicense\n\nMIT`;
		const out = capKeepingSide(text, 1000);
		expect(out.length).toBeLessThanOrEqual(1000);
		expect(out).toContain("[side]\nLicense\n\nMIT");
		expect(out.startsWith("aaa")).toBe(true);
		expect(out).toContain("\n…\n\n[side]");
	});
	test("plain cut without a side block, untouched when it fits", () => {
		expect(capKeepingSide("abcdef", 3)).toBe("abc");
		const t = "x\n\n[side]\ny";
		expect(capKeepingSide(t, 100)).toBe(t);
	});
});
