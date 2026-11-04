import { describe, expect, test } from "bun:test";
import {
	generalSearchUrl,
	isChallenge,
	siteSearchUrl,
} from "../../host/parts/search-urls.ts";

describe("search urls (2026-11-04)", () => {
	test("a known site gets its own search url with the query encoded", () => {
		const url = siteSearchUrl(
			"https://arxiv.org/list/cs.AI/recent",
			"機械 学習",
		);
		expect(url).not.toBeNull();
		expect(url).toContain(encodeURIComponent("機械"));
	});
	test("an unknown site has none", () => {
		expect(siteSearchUrl("https://unknown.example/", "x")).toBeNull();
	});
	test("the general engine is scoped to the site", () => {
		const url = generalSearchUrl("https://unknown.example/a", "term");
		expect(decodeURIComponent(String(url)).replace(/\+/g, " ")).toContain(
			"site:unknown.example term",
		);
	});
	test("challenge pages are recognised; long ordinary pages are not", () => {
		expect(isChallenge("Just a moment...", "")).toBe(true);
		expect(isChallenge("Home", "Please verify you are human")).toBe(true);
		expect(isChallenge("Home", `${"text ".repeat(2000)} captcha`)).toBe(false);
	});
});
