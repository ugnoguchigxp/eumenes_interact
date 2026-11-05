import { describe, expect, test } from "bun:test";
import { toUri } from "../../host/parts/uri.ts";

describe("toUri (L10)", () => {
	test("percent-encodes a non-ASCII path and query as UTF-8", () => {
		expect(toUri("https://ja.wikipedia.org/wiki/東京タワー")).toBe(
			"https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC%E3%82%BF%E3%83%AF%E3%83%BC",
		);
		expect(toUri("https://www.google.com/search?q=天気")).toBe(
			"https://www.google.com/search?q=%E5%A4%A9%E6%B0%97",
		);
	});
	test("keeps escapes already present and a plain ASCII address as is", () => {
		expect(toUri("https://x.example/a%20b?q=%E5%A4%A9天")).toBe(
			"https://x.example/a%20b?q=%E5%A4%A9%E5%A4%A9",
		);
		const ascii = "https://example.com/a b";
		expect(toUri(ascii)).toBe(ascii);
	});
	test("puts a non-ASCII host in punycode", () => {
		expect(toUri("https://日本語.jp/")).toBe("https://xn--wgv71a119e.jp/");
	});
	test("leaves a non-URL unchanged for the policy to refuse", () => {
		expect(toUri("東京タワー")).toBe("東京タワー");
	});
});
