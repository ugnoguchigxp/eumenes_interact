import { describe, expect, test } from "bun:test";
import { generalSearchUrl, isChallenge } from "../../host/parts/search-urls.ts";
import { siteSearchUrl as lookup } from "../../host/site-searches.ts";
import { putSearchTemplate } from "eumenes-interact/sqlite";
import { write } from "../../host/db.ts";
import { freshDb } from "./harness.ts";
const siteSearchUrl = (page: string, query: string) => {
	const db = freshDb();
	try {
		return lookup(db, "lab", page, query, "2026-11-05T00:00:00.000Z");
	} finally {
		db.close();
	}
};

describe("search urls (2026-11-04)", () => {
	test("a store holding a newer hint than the catalog keeps it, and the search goes on (R09)", () => {
		const db = freshDb();
		try {
			write(db, () =>
				putSearchTemplate(db, "lab", {
					origin: "https://www.google.com",
					pathPrefix: "/finance",
					template: "https://www.google.com/finance/?hl=ja&q={q}",
					revision: 5,
					sourceRef: "newer-lab",
					checkedAt: "2026-11-05T00:00:00.000Z",
					expiresAt: "2026-12-04T00:00:00.000Z",
				}),
			);
			expect(
				lookup(
					db,
					"lab",
					"https://www.google.com/finance/",
					"MSFT",
					"2026-11-05T00:00:00.000Z",
				),
			).toBe("https://www.google.com/finance/?hl=ja&q=MSFT");
		} finally {
			db.close();
		}
	});
	test("a page on an origin the store cannot hold has no site search url, and nothing throws (R10)", () => {
		expect(siteSearchUrl("https://my_host.example/list", "x")).toBeNull();
	});
	test("a known site gets its own search url with the query encoded", () => {
		const url = siteSearchUrl(
			"https://arxiv.org/list/cs.AI/recent",
			"機械 学習",
		);
		expect(url).not.toBeNull();
		expect(url).toContain(encodeURIComponent("機械"));
	});
	test("a section of a larger site has its own search url", () => {
		expect(siteSearchUrl("https://www.google.com/finance/", "MSFT")).toBe(
			"https://www.google.com/finance/?q=MSFT",
		);
		expect(siteSearchUrl("https://www.google.com/maps", "x")).toBe(
			"https://www.google.com/search?q=x",
		);
	});
	test("NDL Search and e-Stat have their own search pages (live, 2026-11-04)", () => {
		expect(siteSearchUrl("https://ndlsearch.ndl.go.jp/", "こころ")).toBe(
			`https://ndlsearch.ndl.go.jp/search?cs=bib&keyword=${encodeURIComponent("こころ")}`,
		);
		expect(siteSearchUrl("https://www.e-stat.go.jp/", "人口")).toContain(
			"stat-search?page=1&query=",
		);
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
		expect(isChallenge("Human verification - Stack Overflow", "")).toBe(true);
		// Cloudflare's current wording, reached by following a link (npm, 2026-11-04): the title is the site's.
		expect(
			isChallenge(
				"www.npmjs.com",
				"www.npmjs.com Verifying you are human. This may take a few seconds. www.npmjs.com needs to review the security of your connection before proceeding.",
			),
		).toBe(true);
		expect(isChallenge("npm", "Performing security verification")).toBe(true);
		expect(isChallenge("Home", `${"text ".repeat(2000)} captcha`)).toBe(false);
	});
});
