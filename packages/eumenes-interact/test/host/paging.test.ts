import { describe, expect, test } from "bun:test";
import {
	compilePattern,
	DEFAULT_LEXICON,
} from "../../src/core/shared/lexicon.ts";
import {
	isPagingEntry,
	pagesByStructure,
} from "../../src/host/parts/executor/paging.ts";

const PAGE = "https://shop.example.com/search?q=lamp";
const at = (title: string, url?: string) => ({
	title,
	...(url === undefined ? {} : { url }),
});

describe("pagesByStructure (design R25)", () => {
	test("same path, one numeric query parameter changed", () => {
		for (const url of [
			"/search?q=lamp&page=2",
			"https://shop.example.com/search?q=lamp&p=3",
			"/search?q=lamp&start=20",
			"/search?start=20&q=lamp",
		])
			expect(pagesByStructure(at("Weiter", url), PAGE)).toBe(true);
	});

	test("from page 2, the links to page 1 and page 3 (the first without the parameter)", () => {
		const page2 = `${PAGE}&page=2`;
		expect(pagesByStructure(at("Previous", "/search?q=lamp"), page2)).toBe(
			true,
		);
		expect(pagesByStructure(at("Next", "/search?q=lamp&page=3"), page2)).toBe(
			true,
		);
	});

	test("/page/N over the same path and query", () => {
		const blog = "https://blog.example.org/tag/lamp";
		expect(pagesByStructure(at("Older", "/tag/lamp/page/2/"), blog)).toBe(true);
		expect(
			pagesByStructure(
				at("Newer", "/tag/lamp/page/1"),
				"https://blog.example.org/tag/lamp/page/2",
			),
		).toBe(true);
		expect(pagesByStructure(at("Older", "/tag/desk/page/2/"), blog)).toBe(
			false,
		);
	});

	test("a title of only digits or arrows", () => {
		expect(pagesByStructure(at("12"), PAGE)).toBe(true);
		expect(pagesByStructure(at("٣"), PAGE)).toBe(true);
		expect(pagesByStructure(at("›"), PAGE)).toBe(true);
		expect(pagesByStructure(at("← →"), PAGE)).toBe(true);
		expect(pagesByStructure(at("2024年のまとめ"), PAGE)).toBe(false);
	});

	test("not paging: another origin, another path, another parameter, a big value, two changes, itself", () => {
		const no = (url: string) =>
			expect(pagesByStructure(at("Item", url), PAGE)).toBe(false);
		no("https://other.example.com/search?q=lamp&page=2");
		no("/items?q=lamp&page=2");
		no("/search?q=lamp&sort=price");
		no("/search?q=lamp&year=2023");
		no("/search?q=lamp&page=2&sort=1");
		no("/search?q=desk");
		no("/search?q=lamp");
		no("javascript:void(0)");
	});

	test("a long title is a result, however its address looks", () => {
		expect(
			pagesByStructure(
				at(
					"A long product title that is certainly not a page label",
					"/search?q=lamp&id=7",
				),
				PAGE,
			),
		).toBe(false);
	});

	test("no page address or no link address: the structure says nothing", () => {
		expect(
			pagesByStructure(at("Next", "/search?q=lamp&page=2"), undefined),
		).toBe(false);
		expect(pagesByStructure(at("Next"), PAGE)).toBe(false);
	});
});

describe("isPagingEntry", () => {
	const ctx = { paging: compilePattern(DEFAULT_LEXICON.paging) };

	test("the lexicon is the fallback where the structure is silent", () => {
		expect(isPagingEntry(ctx, at("次へ", "/other"), PAGE)).toBe(true);
		expect(isPagingEntry(ctx, at("next"), PAGE)).toBe(true);
		expect(isPagingEntry(ctx, at("Suivant"), PAGE)).toBe(false);
	});

	test("the structure finds paging the lexicon has no word for", () => {
		expect(
			isPagingEntry(ctx, at("Suivant", "/search?q=lamp&page=2"), PAGE),
		).toBe(true);
	});
});
