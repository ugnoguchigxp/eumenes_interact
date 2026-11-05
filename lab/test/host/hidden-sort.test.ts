import { describe, expect, test } from "bun:test";
import {
	parseSortInspection,
	sortOptionsOf as packageSortOptions,
} from "../../../packages/eumenes-interact/src/adapters/mcp/inspect.ts";
import {
	sortApplied,
	sortOptionsOf,
	sortUrl,
} from "../../host/parts/executor.ts";

// Shapes seen live (2026-11-05): kakaku's hidden `<li onclick="GSLocation.ChangeLocation('sort=priceb|query=…')">`,
// Amazon's sort dropdown (data-* JSON with `s=price-asc-rank`).
const KAKAKU = JSON.stringify([
	{
		text: "価格の安い順",
		visible: false,
		href: null,
		params: [
			["sort", "priceb"],
			["query", "Nintendo%20Switch%202"],
		],
	},
	{ text: "Newest Arrivals", visible: false, href: null, params: [["s", "x"]] },
]);

describe("hidden sort controls (2026-11-05)", () => {
	test("the adapter's answer is checked and capped", () => {
		const r = parseSortInspection(
			JSON.stringify({ count: 1, options: KAKAKU }),
		);
		expect(packageSortOptions(r.options as string)[0]).toEqual({
			text: "価格の安い順",
			visible: false,
			href: null,
			params: [
				["sort", "priceb"],
				["query", "Nintendo%20Switch%202"],
			],
		});
		expect(() => parseSortInspection('{"count":"1"}')).toThrow();
		expect(packageSortOptions("not json")).toEqual([]);
	});

	test("only order words become options", () => {
		expect(sortOptionsOf(KAKAKU).map((o) => o.text)).toEqual(["価格の安い順"]);
		expect(sortOptionsOf(null)).toEqual([]);
	});

	test("the URL gets the choice's parameters; the search word it already carries is left alone", () => {
		const [o] = sortOptionsOf(KAKAKU);
		const url = sortUrl(
			o!,
			"https://search.kakaku.com/Nintendo%20Switch%202/?category=0006_0001",
		);
		expect(url).toBe(
			"https://search.kakaku.com/Nintendo%20Switch%202/?category=0006_0001&sort=priceb",
		);
		expect(sortApplied(url!, { url: url!, params: o!.params })).toBe(true);
		expect(
			sortApplied("https://search.kakaku.com/Nintendo%20Switch%202/", {
				url: url!,
				params: o!.params,
			}),
		).toBe(false);
	});

	test("a choice that changes nothing, or leads off the web, has no URL", () => {
		expect(
			sortUrl(
				{ href: null, params: [["sort", "priceb"]] },
				"https://x.example/?sort=priceb",
			),
		).toBeNull();
		expect(
			sortUrl({ href: "javascript:void(0)", params: [] }, "https://x.example/"),
		).toBeNull();
		expect(
			sortUrl(
				{ href: "/s?k=a&s=price-asc-rank", params: [] },
				"https://x.example/s?k=a",
			),
		).toBe("https://x.example/s?k=a&s=price-asc-rank");
	});
});
