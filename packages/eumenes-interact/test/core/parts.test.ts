import { describe, expect, test } from "bun:test";
import {
	findItems,
	findText,
	formFields,
	listEntries,
	partCallJsonSchema,
	partsApi,
	resolveItem,
	summarizePage,
} from "../../src/core/index.ts";
import { partCallJsonSchemaFor } from "../../src/core/parts/schema.ts";
import { CARD, COMPACT, FORM, RESULTS, TABLE, raw } from "./parts-fixtures.ts";

const summarize = (body: string, options = {}, extra = {}) =>
	summarizePage(raw(body, extra), {
		pageId: "p3",
		maxItems: 100,
		maxHeadings: 10,
		...options,
	});

describe("summarizePage (Playwright MCP)", () => {
	const { summary, records } = summarize(
		RESULTS,
		{},
		{
			url: "https://shop.example.com/search?q=secret#top",
			title: "検索結果 - ほしくず商店",
		},
	);

	test("title, place of the url, headings and regions", () => {
		expect(summary).toMatchObject({
			page: "p3",
			url: "https://shop.example.com/search",
			title: "検索結果 - ほしくず商店",
			headings: ["「電気ケトル」の検索結果"],
			regions: [
				"banner",
				"navigation メインメニュー",
				"search",
				"main",
				"contentinfo",
			],
			itemCount: 11,
			truncated: false,
		});
	});

	test("items get ids in document order, a region and the link's url", () => {
		expect(summary.items.slice(0, 7)).toEqual([
			{
				item: "p3.i1",
				role: "link",
				name: "ほしくず商店",
				region: "banner",
				url: "/",
			},
			{
				item: "p3.i2",
				role: "link",
				name: "ホーム",
				region: "navigation メインメニュー",
				url: "/",
			},
			{
				item: "p3.i3",
				role: "link",
				name: "ヘルプ",
				region: "navigation メインメニュー",
				url: "/help",
			},
			{
				item: "p3.i4",
				role: "searchbox",
				name: "商品を検索",
				region: "search",
			},
			{ item: "p3.i5", role: "button", name: "検索", region: "search" },
			{ item: "p3.i6", role: "main", name: "" },
			{
				item: "p3.i7",
				role: "link",
				name: "電気ケトル 1.0L",
				region: "main",
				url: "/items/kettle-10",
			},
		]);
		expect(summary.items.at(-1)).toMatchObject({
			item: "p3.i11",
			name: "利用規約",
			region: "contentinfo",
		});
	});

	test("neither refs nor paragraph text reach the summary", () => {
		const text = JSON.stringify(summary);
		expect(text).not.toContain("ref");
		expect(text).not.toContain("e15");
		expect(text).not.toContain("要約に出てはいけません");
		expect(text).not.toContain("3,980");
	});

	test("records keep the ref, the position among equal items and their number", () => {
		expect(records[6]).toMatchObject({
			item: "p3.i7",
			ref: "e15",
			nth: 0,
			count: 1,
		});
		const details = records.filter((r) => r.name === "詳細");
		expect(details.map((r) => [r.ref, r.nth])).toEqual([
			["e19", 0],
			["e20", 1],
		]);
		expect(details.every((r) => (r as { count?: number }).count === 2)).toBe(
			true,
		);
	});

	test("ids are deterministic and depend on the page id only by the prefix", () => {
		const again = summarize(RESULTS);
		expect(again.summary.items).toEqual(summary.items);
		const other = summarizePage(raw(RESULTS), {
			pageId: "p9",
			maxItems: 100,
			maxHeadings: 10,
		});
		expect(other.summary.items.map((i) => i.item)).toEqual(
			summary.items.map((i) => i.item.replace("p3", "p9")),
		);
	});

	test("maxItems and maxHeadings cap the summary and say so", () => {
		const capped = summarize(RESULTS, { maxItems: 4 }).summary;
		expect(capped.items).toHaveLength(4);
		expect(capped).toMatchObject({ itemCount: 11, truncated: true });
		expect(summarize(RESULTS, { maxHeadings: 0 }).summary).toMatchObject({
			headings: [],
			truncated: true,
		});
	});

	test("long names are clipped", () => {
		const body = `- main:\n  - button "${"あ".repeat(300)}" [ref=e1]`;
		expect(summarize(body).summary.items[0]!.name).toHaveLength(121);
	});
});

describe("summarizePage (bracketed attributes)", () => {
	const { summary, records } = summarize(COMPACT);

	test("items, urls and refs are read from the attribute lists", () => {
		expect(summary.headings).toEqual(["メインページ"]);
		expect(summary.regions).toEqual(["banner", "main"]);
		expect(
			summary.items.map((i) => [i.item, i.role, i.name, i.region, i.url]),
		).toEqual([
			[
				"p3.i1",
				"link",
				"Wikipedia",
				"banner",
				"https://ja.wikipedia.org/wiki/Main",
			],
			["p3.i2", "searchbox", "Wikipedia内を検索", "banner", undefined],
			[
				"p3.i3",
				"link",
				"寄付",
				"main",
				"https://donate.wikimedia.org/?wmf_source=donate",
			],
			["p3.i4", "radio", "小", "main", undefined],
			["p3.i5", "radio", "大", "main", undefined],
			["p3.i6", "button", "検索", "main", undefined],
		]);
		expect(records.map((r) => r.ref)).toEqual([
			"e1",
			"e26",
			"e27",
			"e322",
			"e323",
			"e28",
		]);
	});
});

describe("content blocks", () => {
	const { summary, records } = summarize(CARD);

	test("articles, named regions, tables, named images, figures and main are items, in document order", () => {
		expect(
			summary.items.map((i) => [i.item, i.role, i.name, i.region]),
		).toEqual([
			["p3.i1", "main", "", undefined],
			["p3.i2", "article", "商品の詳細", "main"],
			["p3.i3", "img", "電気ケトルの写真", "main"],
			["p3.i4", "button", "カートに入れる", "main"],
			["p3.i5", "link", "ヘルプ", "complementary"],
			["p3.i6", "complementary", "関連商品", "main"],
			["p3.i7", "link", "ハンドドリップセット", "complementary 関連商品"],
			["p3.i8", "table", "仕様", "main"],
			["p3.i9", "figure", "", "main"],
		]);
	});

	test("an unnamed image, complementary or region is not an item", () => {
		const names = records.map((r) => r.ref);
		expect(names).not.toContain("e7");
		expect(names).not.toContain("e8");
		expect(names).not.toContain("e14");
	});

	test("a block resolves like any item, and can be found by role", () => {
		const card = records.find((r) => r.role === "article")!;
		expect(card).toMatchObject({ item: "p3.i2", ref: "e3", nth: 0, count: 1 });
		const moved = CARD.replace("[ref=e3]", "[ref=e33]");
		expect(resolveItem(card, moved)).toEqual({ kind: "found", ref: "e33" });
		expect(
			resolveItem(card, CARD.replace('"商品の詳細"', '"別の詳細"')),
		).toEqual({ kind: "none" });
		expect(
			findItems(CARD, "p3", { text: null, role: "article" }, 5).map(
				(r) => r.item,
			),
		).toEqual(["p3.i2"]);
		expect(
			findItems(CARD, "p3", { text: "写真", role: null }, 5).map((r) => r.role),
		).toEqual(["img"]);
		// "any" names no role (live 2026-11-04: World Bank "Population" and a YouTube channel link were missed).
		expect(
			findItems(CARD, "p3", { text: "写真", role: "any" }, 5).map(
				(r) => r.role,
			),
		).toEqual(["img"]);
		expect(
			findItems(CARD, "p3", { text: "写真", role: " " }, 5).map((r) => r.role),
		).toEqual(["img"]);
	});

	test("buttons inside an article are still form-scanned and listed as controls", () => {
		expect(formFields(CARD, "p3", null).submit.map((b) => b.name)).toEqual([
			"カートに入れる",
		]);
	});

	describe("a capped summary keeps the controls first", () => {
		const images = Array.from(
			{ length: 30 },
			(_, i) => `  - img "写真${i}" [ref=g${i}]`,
		);
		const buttons = Array.from(
			{ length: 10 },
			(_, i) => `  - button "操作${i}" [ref=b${i}]`,
		);
		const body = ["- main [ref=m]:", ...images, ...buttons].join("\n");

		test("a quarter of the room, at most 20, goes to blocks; the rest to controls", () => {
			const capped = summarize(body, { maxItems: 12 }).summary;
			const roles = capped.items.map((i) => i.role);
			expect(capped.items).toHaveLength(12);
			expect(roles.filter((r) => r === "button")).toHaveLength(9);
			expect(roles.filter((r) => r !== "button")).toHaveLength(3);
			expect(capped).toMatchObject({ itemCount: 41, truncated: true });
		});

		test("room the controls leave unused goes back to blocks, up to 20", () => {
			const many = [
				"- main [ref=m]:",
				...Array.from(
					{ length: 500 },
					(_, i) => `  - img "写真${i}" [ref=g${i}]`,
				),
				...buttons,
			].join("\n");
			const capped = summarize(many, { maxItems: 100 }).summary;
			const roles = capped.items.map((i) => i.role);
			expect(roles.filter((r) => r === "button")).toHaveLength(10);
			expect(roles.filter((r) => r === "img" || r === "main")).toHaveLength(20);
			expect(capped.items).toHaveLength(30);
			expect(capped).toMatchObject({ itemCount: 511, truncated: true });
		});

		test("items stay in document order and never exceed maxItems", () => {
			for (const maxItems of [1, 4, 12, 40, 41, 100]) {
				const capped = summarize(body, { maxItems }).summary;
				const numbers = capped.items.map((i) => Number(i.item.split(".i")[1]));
				expect(capped.items.length).toBeLessThanOrEqual(maxItems);
				expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
				expect(capped.truncated).toBe(maxItems < 41);
			}
		});
	});
});

describe("resolveItem", () => {
	const old = summarize(RESULTS).records;
	const record = (name: string, nth = 0) =>
		old.filter((r) => r.name === name)[nth]!;

	test("finds the same element again, wherever its ref moved", () => {
		const moved = RESULTS.replace("[ref=e15]", "[ref=e115]");
		expect(resolveItem(record("電気ケトル 1.0L"), moved)).toEqual({
			kind: "found",
			ref: "e115",
		});
	});

	test("picks nth among equal elements while their number is unchanged", () => {
		const moved = RESULTS.replace("[ref=e20]", "[ref=e120]").replace(
			"[ref=e19]",
			"[ref=e119]",
		);
		expect(resolveItem(record("詳細", 0), moved)).toEqual({
			kind: "found",
			ref: "e119",
		});
		expect(resolveItem(record("詳細", 1), moved)).toEqual({
			kind: "found",
			ref: "e120",
		});
	});

	test("is ambiguous, with candidates, when the number of equal elements changed", () => {
		const fewer = RESULTS.replace(
			'      - link "詳細" [ref=e20]:\n        - /url: /items/b\n',
			"",
		);
		const resolved = resolveItem(record("詳細", 1), fewer);
		expect(resolved.kind).toBe("ambiguous");
		if (resolved.kind === "ambiguous")
			expect(resolved.candidates.map((c) => [c.name, c.url])).toEqual([
				["詳細", "/items/a"],
			]);
		const more = RESULTS.replace(
			"- contentinfo [ref=e21]:",
			'  - link "詳細" [ref=e30]:\n    - /url: /items/c\n- contentinfo [ref=e21]:',
		);
		expect(resolveItem(record("詳細", 0), more).kind).toBe("ambiguous");
	});

	test("is none when nothing matches, and never picks the first of several", () => {
		expect(
			resolveItem(record("ヘルプ"), RESULTS.replace('"ヘルプ"', '"サポート"')),
		).toEqual({ kind: "none" });
		expect(resolveItem(record("ヘルプ"), "")).toEqual({ kind: "none" });
		// The region is part of the identity: the same name elsewhere is another element.
		const elsewhere = RESULTS.replace(
			'navigation "メインメニュー"',
			'navigation "別のメニュー"',
		);
		expect(resolveItem(record("ヘルプ"), elsewhere)).toEqual({ kind: "none" });
	});
});

describe("findItems", () => {
	test("matches names case-insensitively and by NFKC, in document order", () => {
		const names = (q: { text: string | null; role: string | null }) =>
			findItems(RESULTS, "p3", q, 20).map((r) => r.item);
		expect(names({ text: "電気ケトル", role: null })).toEqual([
			"p3.i7",
			"p3.i8",
		]);
		expect(names({ text: "ＨＯＭＥ", role: null })).toEqual([]);
		expect(names({ text: "ほしくず", role: "link" })).toEqual(["p3.i1"]);
		const latin = `- main:\n  - link "Wikipedia ＡＢＣ" [ref=e1]\n  - button "wikipedia" [ref=e2]`;
		expect(
			findItems(latin, "p1", { text: "wikipedia abc", role: null }, 5).map(
				(r) => r.ref,
			),
		).toEqual(["e1"]);
		expect(
			findItems(latin, "p1", { text: "WIKIPEDIA", role: null }, 5).map(
				(r) => r.ref,
			),
		).toEqual(["e1", "e2"]);
	});

	test("the role is exact and may stand alone; the limit applies", () => {
		expect(
			findItems(RESULTS, "p3", { text: null, role: "button" }, 20).map(
				(r) => r.name,
			),
		).toEqual(["検索"]);
		expect(
			findItems(RESULTS, "p3", { text: null, role: "link" }, 3),
		).toHaveLength(3);
		expect(findItems(RESULTS, "p3", { text: null, role: "lin" }, 3)).toEqual(
			[],
		);
	});

	test("works on bracketed attributes too", () => {
		expect(
			findItems(COMPACT, "p1", { text: "寄付", role: null }, 5)[0],
		).toMatchObject({
			ref: "e27",
			url: "https://donate.wikimedia.org/?wmf_source=donate",
		});
	});
});

describe("listEntries", () => {
	test("results are the named links of list items in main, with their short text", () => {
		const { entries, records, truncated } = listEntries(
			RESULTS,
			"p3",
			"results",
			10,
		);
		expect(truncated).toBe(false);
		expect(entries.map((e) => [e.item, e.title, e.url, e.text])).toEqual([
			["p3.i7", "電気ケトル 1.0L", "/items/kettle-10", "¥3,980"],
			["p3.i8", "電気ケトル 0.8L", "/items/kettle-08", "¥2,980"],
			["p3.i9", "詳細", "/items/a", undefined],
			["p3.i10", "詳細", "/items/b", undefined],
		]);
		expect(records.map((r) => r.ref)).toEqual(["e15", "e17", "e19", "e20"]);
	});

	test("navigation and the footer are not results", () => {
		const titles = listEntries(RESULTS, "p3", "results", 10).entries.map(
			(e) => e.title,
		);
		expect(titles).not.toContain("ホーム");
		expect(titles).not.toContain("利用規約");
	});

	test("a compact tree falls back to the named links of main", () => {
		expect(
			listEntries(COMPACT, "p3", "results", 10).entries.map((e) => e.title),
		).toEqual(["寄付"]);
	});

	test("a link with an empty name is named by its inner text, else its URL (MDN results, 2026-11-04)", () => {
		const body = [
			"- main:",
			"  - list:",
			"    - listitem:",
			"      - link [ref=e5, url=https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/Array/flat]:",
			"        - code: Array.prototype.flat()",
			"    - listitem:",
			"      - link [ref=e6, url=https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/Array/flatMap]",
		].join("\n");
		const titles = listEntries(body, "p3", "results", 10).entries.map(
			(e) => e.title,
		);
		expect(titles).toEqual(["Array.prototype.flat()", "flatMap"]);
	});

	test("links are every named link; the limit marks truncation", () => {
		const all = listEntries(RESULTS, "p3", "links", 50);
		expect(all.entries).toHaveLength(8);
		const some = listEntries(RESULTS, "p3", "links", 3);
		expect(some).toMatchObject({ truncated: true });
		expect(some.entries).toHaveLength(3);
		expect(some.records).toHaveLength(3);
	});

	test("a table is one entry per row, cells joined by ' | '", () => {
		const { entries, records } = listEntries(TABLE, "p3", "table", 10);
		expect(entries).toEqual([
			{ title: "名前 | 価格" },
			{ title: "電気ケトル | ¥3,980", item: "p3.i3", url: "/items/kettle-10" },
			{ title: "ハンドドリップセット | ¥5,400" },
		]);
		expect(records.map((r) => r.ref)).toEqual(["e6"]);
		expect(listEntries(RESULTS, "p3", "table", 10).entries).toEqual([]);
	});
});

describe("formFields", () => {
	test("the first form: fields with label, kind, required, options and filled", () => {
		const { fields, submit, records } = formFields(FORM, "p3", null);
		expect(fields).toEqual([
			{
				item: "p3.i4",
				label: "お名前",
				kind: "textbox",
				required: true,
				filled: false,
			},
			{
				item: "p3.i5",
				label: "メール",
				kind: "textbox",
				required: true,
				filled: true,
			},
			{
				item: "p3.i6",
				label: "種別",
				kind: "combobox",
				options: ["質問", "要望"],
				filled: true,
			},
			{
				item: "p3.i7",
				label: "メールでの返信を希望する",
				kind: "checkbox",
				filled: true,
			},
			{ item: "p3.i8", label: "個人", kind: "radio", filled: false },
			{ item: "p3.i9", label: "法人", kind: "radio", filled: true },
		]);
		expect(submit.map((b) => b.name)).toEqual(["送信", "リセット"]);
		expect(records.map((r) => r.ref)).toEqual([
			"e8",
			"e9",
			"e10",
			"e11",
			"e12",
			"e13",
			"e14",
			"e15",
		]);
	});

	test("a given form item scopes the fields to it", () => {
		const form = summarize(FORM).records.find((r) => r.role === "form")!;
		expect(form).toMatchObject({ item: "p3.i3", name: "お問い合わせフォーム" });
		expect(formFields(FORM, "p3", form).fields).toHaveLength(6);
		// The same form in a newer snapshot is found by role, name and region.
		const moved = FORM.replace("[ref=e7]", "[ref=e77]");
		expect(formFields(moved, "p3", form).fields).toHaveLength(6);
		expect(formFields('- main:\n  - button "x" [ref=e1]', "p3", form)).toEqual({
			fields: [],
			submit: [],
			records: [],
		});
	});

	test("without a form the main region is scanned", () => {
		const body =
			'- main:\n  - searchbox "検索" [ref=e1]\n  - button "検索" [ref=e2]\n- banner:\n  - button "x" [ref=e3]';
		const { fields, submit } = formFields(body, "p1", null);
		expect(fields.map((f) => f.label)).toEqual(["検索"]);
		expect(submit.map((b) => b.name)).toEqual(["検索"]);
	});

	const TWO_FORMS = [
		"- main:",
		'  - form "サイト内検索" [ref=e1]:',
		'    - searchbox "キーワード" [ref=e2]',
		'    - button "検索" [ref=e3]',
		'  - form "会員登録" [ref=e4]:',
		'    - textbox "お名前" [ref=e5]',
		'    - checkbox "お知らせを受け取る" [checked] [ref=e6]',
		'    - button "登録する" [ref=e7]',
	].join("\n");

	test("without a form and with several, none is chosen: the whole page is shown", () => {
		const { fields, submit } = formFields(TWO_FORMS, "p1", null);
		expect(fields.map((f) => f.label)).toEqual([
			"キーワード",
			"お名前",
			"お知らせを受け取る",
		]);
		expect(submit.map((b) => b.name)).toEqual(["検索", "登録する"]);
	});

	test('"page" scans every field of the page, wherever it sits', () => {
		const body = `${TWO_FORMS}\n- complementary:\n  - checkbox "保存する" [ref=e8]`;
		const { fields } = formFields(body, "p1", "page");
		expect(fields.map((f) => [f.label, f.filled])).toEqual([
			["キーワード", false],
			["お名前", false],
			["お知らせを受け取る", true],
			["保存する", false],
		]);
	});

	test("a form item is always found again by what it is, not by an old ref another form now has", () => {
		const register = summarize(TWO_FORMS).records.find(
			(r) => r.role === "form" && r.name === "会員登録",
		)!;
		// In a newer snapshot the search form took the register form's old ref.
		const swapped = TWO_FORMS.replace("[ref=e4]", "[ref=e40]").replace(
			"[ref=e1]",
			"[ref=e4]",
		);
		const { fields } = formFields(swapped, "p1", register);
		expect(fields.map((f) => f.label)).toEqual([
			"お名前",
			"お知らせを受け取る",
		]);
	});

	test("bracketed attributes: checked state", () => {
		const { fields, submit } = formFields(COMPACT, "p1", null);
		expect(fields.map((f) => [f.label, f.kind, f.filled])).toEqual([
			["小", "radio", false],
			["大", "radio", true],
		]);
		expect(submit.map((b) => b.name)).toEqual(["検索"]);
	});
});

describe("partCallJsonSchema", () => {
	const schema = partCallJsonSchema() as {
		type: string;
		required: string[];
		properties: {
			part: { type: string; enum: string[] };
			args: { anyOf: unknown[] };
		};
	};
	const UNSUPPORTED = [
		"minLength",
		"maxLength",
		"minimum",
		"maximum",
		"exclusiveMinimum",
		"exclusiveMaximum",
		"multipleOf",
		"pattern",
		"minItems",
		"maxItems",
		"$ref",
		"$defs",
		"$schema",
		"oneOf",
		"format",
	];
	const walk = (node: unknown, visit: (n: Record<string, unknown>) => void) => {
		if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
		else if (node && typeof node === "object") {
			visit(node as Record<string, unknown>);
			Object.values(node).forEach((n) => walk(n, visit));
		}
	};
	const PARTS = [
		"page.open",
		"page.back",
		"site.search",
		"page.find",
		"item.open",
		"page.wait",
		"page.read",
		"page.list",
		"page.capture",
		"form.inspect",
		"form.fill",
		"form.submit",
		"done",
		"ask",
	];

	test("the root is one closed object with a part enum and a union of arguments", () => {
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["part", "args"]);
		expect(Object.keys(schema.properties)).toEqual(["part", "args"]);
		expect(schema.properties.part).toEqual({ type: "string", enum: PARTS });
		expect(Object.keys(schema.properties.args)).toEqual(["anyOf"]);
		expect(schema).toMatchObject({ additionalProperties: false });
	});

	test("contains no keyword the structured-output subset lacks", () => {
		walk(schema, (n) => {
			for (const key of UNSUPPORTED) expect(Object.keys(n)).not.toContain(key);
		});
	});

	test("every object is closed and lists all its properties as required", () => {
		let objects = 0;
		walk(schema, (n) => {
			if (n.type !== "object") return;
			objects++;
			expect(n.additionalProperties).toBe(false);
			expect(n.required).toEqual(Object.keys(n.properties as object));
		});
		expect(objects).toBeGreaterThan(14);
	});

	test("equal argument objects are listed once", () => {
		const args = schema.properties.args.anyOf as { properties: object }[];
		expect(
			args.filter((a) => Object.keys(a.properties).length === 0),
		).toHaveLength(1);
		expect(new Set(args.map((a) => JSON.stringify(a))).size).toBe(args.length);
		// 14 parts: page.back is the only part without arguments, and the others differ.
		expect(args).toHaveLength(14);
	});

	test("a narrowed set narrows the enum and the arguments", () => {
		const narrowed = partCallJsonSchemaFor([
			"page.back",
			"ask",
		]) as typeof schema;
		expect(narrowed.properties.part.enum).toEqual(["page.back", "ask"]);
		expect(narrowed.properties.args.anyOf).toHaveLength(2);
		const empty = partCallJsonSchemaFor(["page.back"]) as typeof schema;
		expect(empty.properties.args.anyOf).toEqual([
			{
				type: "object",
				properties: {},
				required: [],
				additionalProperties: false,
			},
		]);
	});

	test("is a fresh copy and part of partsApi", () => {
		partCallJsonSchema().extra = 1;
		expect(partCallJsonSchema().extra).toBeUndefined();
		expect(Object.keys(partsApi).sort()).toEqual([
			"findItems",
			"formFields",
			"listEntries",
			"partCallJsonSchema",
			"resolveItem",
			"summarizePage",
		]);
	});
});

describe("findText and the main-first cap (2026-11-04)", () => {
	const PAGE = [
		"- banner [ref=e1]:",
		'  - link "ログイン" [ref=e2]',
		'  - link "ヘルプ" [ref=e3]',
		"- main [ref=e4]:",
		"  - listitem [ref=e5]:",
		'    - link "肉じゃが" [ref=e6]',
		"    - paragraph: 材料は じゃがいも と 牛肉",
		"  - paragraph: 最終更新 2026年11月1日",
	].join("\n");

	test("text in the body is found with the item of its list item", () => {
		const r = findText(PAGE, "p1", "じゃがいも", 5);
		expect(r.hits).toEqual([
			{ text: "材料は じゃがいも と 牛肉", item: "p1.i4" },
		]);
	});

	test("a hit outside a container names the item just before it; no match is empty", () => {
		expect(findText(PAGE, "p1", "最終更新", 5).hits[0]?.item).toBe("p1.i4");
		expect(findText(PAGE, "p1", "存在しない", 5).hits).toEqual([]);
		expect(findText(PAGE, "p1", "  ", 5).hits).toEqual([]);
	});

	test("a capped summary keeps the main content before the banner's links", () => {
		const { summary } = summarizePage(raw(PAGE), {
			pageId: "p1",
			maxItems: 1,
			maxHeadings: 5,
		});
		expect(summary.items.map((i) => i.name)).toEqual(["肉じゃが"]);
	});
});

describe("findText widens a label to its row (2026-11-04)", () => {
	const PAGE = [
		"- main:",
		'  - link "トップ" [ref=e1]:',
		"    - /url: /",
		"  - table:",
		"    - row:",
		'      - cell "初出："',
		'      - cell "「朝日新聞」1914（大正3）年4～8月"',
		"  - generic:",
		"    - term: 出版年",
		"    - definition: 大正6",
	].join("\n");
	test("a cell's name is searched, and the label comes back with its value", () => {
		const r = findText(PAGE, "p1", "初出", 5);
		expect(r.hits[0]?.text).toContain("1914");
		const y = findText(PAGE, "p1", "出版年", 5);
		expect(y.hits[0]?.text).toContain("大正6");
	});
});

describe("findText: a link in a table row brings its row (World Bank, 2026-11-04)", () => {
	const PAGE = [
		"- main:",
		"  - table:",
		"    - row:",
		"      - cell:",
		'        - link "Japan" [ref=e1]:',
		"          - /url: /indicator/SP.POP.TOTL?locations=JP",
		'      - cell "2025"',
		'      - cell "123,366.73"',
	].join("\n");
	test("the row's values come back with the link", () => {
		const r = findText(PAGE, "p1", "Japan", 5);
		expect(r.hits[0]?.text).toContain("123,366.73");
	});
});

describe("findText: an infobox label row brings the rows below it (Wikipedia 日本, 2026-11-04)", () => {
	const PAGE = [
		"- main:",
		"  - table:",
		"    - rowgroup:",
		"      - row:",
		'        - rowheader "人口":',
		'          - link "人口" [ref=e1]:',
		"            - /url: /wiki/人口",
		'      - row "総計（2024年） 123,802,000人"',
		'      - row "人口密度 331.7人/km2"',
		'      - row "GDP 600兆円"',
		'      - row "通貨 円"',
	].join("\n");
	test("the figures come back with the label", () => {
		const r = findText(PAGE, "p1", "人口", 5);
		expect(r.hits[0]?.text).toContain("123,802,000");
	});
});
