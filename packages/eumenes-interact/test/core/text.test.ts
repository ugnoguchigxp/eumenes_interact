import { describe, expect, test } from "bun:test";
import { addSeen, fromPage, urlPayload } from "../../src/core/shared/text.ts";

describe("urlPayload", () => {
	test("is the decoded path, query names and values, and fragment; not the host", () => {
		expect(
			urlPayload(
				"https://evil.example/a%20b/c?name=%E5%B1%B1%E7%94%B0+%E5%A4%AA&z=1#frag",
			),
		).toBe("a b\nc\nname\n山田 太\nz\n1\nfrag");
		expect(urlPayload("https://evil.example/")).toBe("");
		expect(urlPayload("not a url")).toBeNull();
		// A broken escape is kept as it is, not thrown.
		expect(urlPayload("https://x.example/%E0%A4%A")).toContain("%E0%A4%A");
	});

	test("with fromPage: page text in the address is found, the request's own is not", () => {
		const seen = addSeen([], "お問い合わせ番号 090-1234-5678 山田太郎");
		const sent = urlPayload("https://x.example/?q=090%201234%205678") as string;
		expect(fromPage(sent, "", seen)).toBe(true);
		expect(fromPage(sent, "電話は090-1234-5678です", seen)).toBe(false);
		expect(fromPage("short", "", seen)).toBe(false);
	});

	test("a subdomain and userinfo carry data too; the registrable name and an IP do not count", () => {
		expect(urlPayload("https://8f3k29dj71.evil.com/")).toBe("8f3k29dj71");
		expect(urlPayload("https://u8f3k29dj71@evil.com/")).toBe("u8f3k29dj71");
		expect(urlPayload("https://www.example.com/")).toBe("www");
		expect(urlPayload("https://203.0.113.9/")).toBe("");
		const seen = addSeen([], "token 8f3k29dj71ab on the page");
		expect(
			fromPage(urlPayload("https://8f3k29dj71ab.evil.com/")!, "", seen),
		).toBe(true);
	});

	test("a long address against a long page is answered quickly (one pass per page)", () => {
		const seen = addSeen([], "あ".repeat(500_000));
		const started = performance.now();
		expect(fromPage("い".repeat(2_000), "", seen)).toBe(false);
		expect(performance.now() - started).toBeLessThan(400);
	});
});
