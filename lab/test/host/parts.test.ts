import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AdapterError, type PartResult } from "eumenes-interact";
import { FixtureApprover } from "../../host/approval.ts";
import { partsHelpers, type PartsHelpers } from "../../host/parts/core.ts";
import { captureRangeScore, captureTargetHash } from "../../scorer/captures.ts";
import { devCase } from "../scorer/builder.ts";
import { BASE } from "./fake-adapter.ts";
import {
	HOSHI,
	KAEDE,
	call,
	idOf,
	setupParts,
	type PartsSetup,
} from "./parts-harness.ts";

const open: PartsSetup[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.cleanup();
});
const setup = async (...args: Parameters<typeof setupParts>) => {
	const s = await setupParts(...args);
	open.push(s);
	return s;
};

const codes = (r: PartResult) => [r.status, r.code];

describe("page.open and page.back", () => {
	test("a page inside the allowed origin is opened and summarised; the summary has ids, no refs", async () => {
		const s = await setup();
		const r = await s.result(
			call("page.open", { url: `${KAEDE}catalog.html` }),
		);
		expect(r.status).toBe("completed");
		expect(r.page?.title).toBe("全商品 | 楓雑貨店");
		expect(r.page?.page).toMatch(/^p\d+$/);
		expect(r.page?.items.every((i) => i.item.startsWith(r.page!.page))).toBe(
			true,
		);
		expect(JSON.stringify(r)).not.toMatch(/\[ref=|"ref"|e\d+\]/);
		expect(s.adapter.url).toBe(`${KAEDE}catalog.html`);
	});

	describe("an address that carries page text asks first (R21)", () => {
		const TEXT = "暮らしの小物を、ひとつずつ手づくりで。";
		const deny = () => new FixtureApprover({ decision: "deny" });

		test("page text in the query, not in the request, is approved by the user first", async () => {
			const s = await setup({ approver: deny() });
			const before = s.adapter.dispatched.length;
			const executed = await s.run(
				call("page.open", {
					url: `${KAEDE}results.html?q=${encodeURIComponent(TEXT)}`,
				}),
			);
			expect(executed).toMatchObject({
				kind: "outcome",
				outcome: { kind: "stop", code: "approval_denied" },
			});
			expect(s.adapter.dispatched.length).toBe(before);
		});

		test("the same text in the path or the fragment asks as well, and a grant lets it through", async () => {
			const asked: string[] = [];
			const s = await setup({
				approver: {
					decide: (prompt) => {
						asked.push(prompt.element);
						return Promise.resolve("grant");
					},
				},
			});
			const r = await s.result(
				call("page.open", {
					url: `${KAEDE}${encodeURIComponent("暮らしの小物をひとつずつ手づくりで")}.html`,
				}),
			);
			expect(asked).toHaveLength(1);
			expect(asked[0]).toContain(KAEDE);
			expect(r.status).toBeDefined();
			const s2 = await setup({ approver: deny() });
			const frag = await s2.run(
				call("page.open", {
					url: `${KAEDE}catalog.html?x=${encodeURIComponent(TEXT)}#frag`,
				}),
			);
			expect(frag).toMatchObject({ outcome: { code: "approval_denied" } });
		});

		test("a link the run saw, and an address the request states, open without asking", async () => {
			const s = await setup({
				approver: deny(),
				request: `${KAEDE}results.html?q=${encodeURIComponent(TEXT)} を開いてください。`,
			});
			// A link on the start page.
			expect(
				(await s.result(call("page.open", { url: `${KAEDE}catalog.html` })))
					.status,
			).toBe("completed");
			// The request's own address, though its query holds text the first page showed.
			const own = await s.result(
				call("page.open", {
					url: `${KAEDE}results.html?q=${encodeURIComponent(TEXT)}`,
				}),
			);
			expect(own.status).toBe("completed");
		});

		test("text only the request has, or an address with no page text, opens without asking", async () => {
			const s = await setup({
				approver: deny(),
				request: "麻のふきんを探してください。",
			});
			const asked = await s.result(
				call("page.open", {
					url: `${KAEDE}results.html?q=${encodeURIComponent("麻のふきん")}`,
				}),
			);
			expect(asked.status).toBe("completed");
			const plain = await s.result(
				call("page.open", { url: `${KAEDE}care.html` }),
			);
			expect(plain.status).toBe("completed");
		});

		test("text from an earlier verified result is a source like the request", async () => {
			const s = await setup({ approver: deny(), sources: [TEXT] });
			const r = await s.result(
				call("page.open", {
					url: `${KAEDE}results.html?q=${encodeURIComponent(TEXT)}`,
				}),
			);
			expect(r.status).toBe("completed");
		});
	});

	test("a destination outside the origin is refused by the policy before it is sent", async () => {
		const s = await setup();
		const before = s.adapter.dispatched.length;
		const r = await s.result(
			call("page.open", { url: "http://evil.example/" }),
		);
		expect(codes(r)).toEqual(["failed", "navigation_out_of_scope"]);
		expect(s.adapter.dispatched.length).toBe(before);
		expect(s.operations()).toHaveLength(0);
	});

	test("back returns to the previous page", async () => {
		const s = await setup();
		await s.result(call("page.open", { url: `${KAEDE}catalog.html` }));
		s.adapter.onDispatch = (command, b) => {
			if (command.action !== "browser.back") return undefined;
			b.goto(`${KAEDE}index.html`);
			return {
				status: "confirmed",
				retryable: false,
				url: `${KAEDE}index.html`,
				title: "楓雑貨店",
			};
		};
		const r = await s.result(call("page.back", {}));
		expect(r.status).toBe("completed");
		expect(r.page?.title).toBe("楓雑貨店");
	});

	test("every inner operation went through the ledger", async () => {
		const s = await setup();
		await s.result(call("page.open", { url: `${KAEDE}catalog.html` }));
		const ops = s.operations();
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ status: "confirmed" });
	});
});

describe("site.search: model-selected target (F09)", () => {
	const request = "Search for test";
	test("discovery never types or navigates and returns every kind of editable field", async () => {
		const s = await setup({ request });
		const before = s.adapter.dispatched.length;
		const r = await s.result(
			call("site.search", { query: "test", field: null }),
		);
		expect(r.code).toBe("target_required");
		expect(r.candidates?.length).toBeGreaterThan(0);
		expect(r.searchUrls?.length).toBeGreaterThan(0);
		expect(s.adapter.dispatched).toHaveLength(before);
	});
	test("only the explicitly selected observed field receives the sourced query", async () => {
		const s = await setup({ request });
		const field = s.summary.items.find((i) => i.role === "searchbox")!.item;
		const r = await s.result(call("site.search", { query: "test", field }));
		expect(r.status).toBe("completed");
		expect(s.adapter.dispatched.at(-1)).toMatchObject({
			action: "page.fill",
			text: "test",
			submit: true,
		});
		expect(r.list).toBeUndefined(); // The model, not the part, judges whether there are results.
	});
	test("an unobserved target and unsourced query cannot trigger input", async () => {
		const s = await setup({ request });
		const before = s.adapter.dispatched.length;
		expect(
			(await s.result(call("site.search", { query: "test", field: "p999.i1" })))
				.code,
		).toBeDefined();
		expect(
			(await s.result(call("site.search", { query: "outside", field: null })))
				.code,
		).toBe("query_not_in_request");
		expect(s.adapter.dispatched).toHaveLength(before);
	});
	test("two search boxes remain candidates until the model chooses one", async () => {
		const s = await setup({
			start: `${BASE}sites/hoshikuzu/duplicate/index.html`,
			request,
		});
		const before = s.adapter.dispatched.length;
		const r = await s.result(
			call("site.search", { query: "test", field: null }),
		);
		expect(
			r.candidates!.filter((i) => i.role === "searchbox").length,
		).toBeGreaterThan(1);
		expect(s.adapter.dispatched).toHaveLength(before);
	});
	test("a confirmed input that leaves the same page does not assert search success or try a fallback", async () => {
		const s = await setup({ request });
		s.adapter.onDispatch = (c) =>
			c.action === "page.fill"
				? { status: "confirmed", retryable: false, url: s.adapter.url }
				: undefined;
		const before = s.adapter.dispatched.length;
		const field = s.summary.items.find((i) => i.role === "searchbox")!.item;
		const r = await s.result(call("site.search", { query: "test", field }));
		expect(r.status).toBe("completed");
		expect(r.list).toBeUndefined();
		expect(s.adapter.dispatched.slice(before).map((c) => c.action)).toEqual([
			"page.fill",
		]);
	});
	test("paging, ads and unfamiliar labels are returned in source order, without semantic classification", async () => {
		const titles = ["Suivant", "Sponsored", "Unfamiliar", "2", "Item"];
		const s = await setup({
			core: {
				...partsHelpers,
				listEntries: () => ({
					entries: titles.map((title) => ({ title })),
					records: [],
					truncated: false,
				}),
			},
		});
		const r = await s.result(call("page.list", { kind: "results", limit: 10 }));
		expect(r.list?.entries.map((e) => e.title)).toEqual(titles);
	});
});

describe("site.search: where a search word may come from (2026-11-04)", () => {
	const request = "「麻」の商品を探して、その説明会の動画を見せてください。";

	test("a generated step goal cannot authorize additional search data", async () => {
		const s = await setup({ request, goal: "麻 の earnings 動画を探す" });
		const r = await s.result(call("site.search", { query: "麻 earnings" }));
		expect(r.code).toBe("query_not_in_request");
	});

	test("a name or number in the goal still needs the request or an earlier result", async () => {
		const s = await setup({ request, goal: "Microsoft FY27 の earnings" });
		for (const q of ["麻 Microsoft", "麻 FY27"])
			expect(codes(await s.result(call("site.search", { query: q })))).toEqual([
				"failed",
				"query_not_in_request",
			]);
		const t = await setup({
			request,
			goal: "FY27 の earnings",
			sources: ["FY27 Q1"],
		});
		expect(
			(await t.result(call("site.search", { query: "麻 FY27" }))).code,
		).not.toBe("query_not_in_request");
	});

	test("lowercase spelling cannot disguise unsourced data as common words", async () => {
		const s = await setup({ request });
		expect(
			(await s.result(call("site.search", { query: "麻 earnings" }))).code,
		).toBe("query_not_in_request");
		for (const q of [
			"earnings",
			"麻 unpublishedprivatevalue",
			"麻 earnings call review",
			"麻 Azure",
		])
			expect(codes(await s.result(call("site.search", { query: q })))).toEqual([
				"failed",
				"query_not_in_request",
			]);
	});
});

describe("page.find", () => {
	test("returns candidates with ids, roles, names and regions", async () => {
		const s = await setup({ start: `${KAEDE}catalog.html` });
		const r = await s.result(call("page.find", { text: "麻", role: "link" }));
		expect(r.status).toBe("completed");
		expect(r.candidates?.map((c) => c.name)).toEqual([
			"麻のふきん",
			"麻のエプロン",
			"麻のふきん",
			"麻のエプロン",
		]);
		expect(new Set(r.candidates?.map((c) => c.region))).toEqual(
			new Set([
				"region キッチン",
				"region ファッション",
				"region 季節のおすすめ",
			]),
		);
	});

	test("text that names no item is found in the page body, with the item beside it (2026-11-04)", async () => {
		const s = await setup({ start: `${KAEDE}care.html` });
		const r = await s.result(call("page.find", { text: "目安", role: null }));
		expect(r.status).toBe("completed");
		expect(r.read?.text).toContain("素材ごとの目安は下の表のとおりです。");
	});

	test("a named item does not hide the body text that says the same (live World Bank / Wikipedia, 2026-11-04)", async () => {
		const s = await setup({ start: `${KAEDE}care.html` });
		const r = await s.result(
			call("page.find", { text: "素材ごと", role: null }),
		);
		expect(r.status).toBe("completed");
		expect(r.candidates?.map((c) => c.role)).toContain("table");
		expect(r.read?.text).toContain("素材ごとの目安は下の表のとおりです。");
	});

	test("a phrase not on the page falls back to its words, saying which matched (2026-11-05)", async () => {
		const s = await setup({ start: `${KAEDE}care.html` });
		const r = await s.result(
			call("page.find", { text: "存在しない 目安", role: null }),
		);
		expect(r.status).toBe("completed");
		expect(r.read?.text).toContain(
			"[語ごとの一致: 目安（「存在しない 目安」そのものはなし）]",
		);
		expect(r.read?.text).toContain("素材ごとの目安は下の表のとおりです。");
		const none = await s.result(
			call("page.find", { text: "存在しない 語句", role: null }),
		);
		expect(codes(none)).toEqual(["failed", "target_not_found"]);
	});

	test("finding nothing is a failure with an empty candidate list, never a guess", async () => {
		const s = await setup();
		const r = await s.result(
			call("page.find", { text: "存在しない", role: null }),
		);
		expect(codes(r)).toEqual(["failed", "target_not_found"]);
		expect(r.candidates).toEqual([]);
	});
});

describe("item ids and their resolution", () => {
	test("an id the host never issued names nothing", async () => {
		const s = await setup();
		const r = await s.result(call("item.open", { item: "p9.i1" }));
		expect(codes(r)).toEqual(["failed", "item_unknown"]);
		expect(s.adapter.dispatched).toHaveLength(1);
	});

	test("an id of a page the tab has left is expired and the fresh summary comes with it", async () => {
		const s = await setup();
		const staleId = idOf(s.summary.items, "link", "全商品");
		await s.result(call("page.open", { url: `${KAEDE}care.html` }));
		const r = await s.result(call("item.open", { item: staleId }));
		expect(codes(r)).toEqual(["failed", "item_expired"]);
		expect(r.page?.title).toBe("お手入れガイド | 楓雑貨店");
	});

	test("an element that is gone is target_not_found with look-alike candidates", async () => {
		const s = await setup({
			core: {
				...partsHelpers,
				resolveItem: () => ({ kind: "none" }),
			},
		});
		const id = idOf(s.summary.items, "link", "全商品");
		const r = await s.result(call("item.open", { item: id }));
		expect(codes(r)).toEqual(["failed", "target_not_found"]);
		expect(r.candidates?.map((c) => c.name)).toContain("全商品");
		expect(s.adapter.dispatched).toHaveLength(1);
	});

	test("several matches are target_ambiguous: candidates come back and nothing is clicked", async () => {
		const s = await setup({
			core: {
				...partsHelpers,
				resolveItem: () => ({ kind: "ambiguous", candidates: [] }),
			},
		});
		const id = idOf(s.summary.items, "link", "ホーム");
		const r = await s.result(call("item.open", { item: id }));
		expect(codes(r)).toEqual(["failed", "target_ambiguous"]);
		expect(r.candidates?.length).toBeGreaterThan(0);
		expect(s.adapter.dispatched).toHaveLength(1);
	});

	test("an empty-name link the page re-rendered is opened by its URL (MDN results), not clicked by guess", async () => {
		const blank = <T extends { role: string; name: string }>(x: T) =>
			x.role === "link" && x.name === "全商品" ? { ...x, name: "" } : x;
		const s = await setup({
			core: {
				...partsHelpers,
				summarizePage: (o, opt) => {
					const r = partsHelpers.summarizePage(o, opt);
					return {
						summary: { ...r.summary, items: r.summary.items.map(blank) },
						records: r.records.map(blank),
					};
				},
				resolveItem: () => ({ kind: "none" }),
			},
		});
		const item = s.summary.items.find(
			(i) => i.role === "link" && i.name === "" && i.url,
		);
		expect(item).toBeDefined();
		const r = await s.result(call("item.open", { item: item!.item }));
		expect(r.status).toBe("completed");
		expect(JSON.stringify(s.adapter.dispatched.at(-1))).toContain(
			"browser.navigate",
		);
	});

	test("ids of the summary, a list and a form of one page agree", async () => {
		const s = await setup({ start: `${KAEDE}catalog.html` });
		const found = await s.result(
			call("page.find", { text: "木のスプーン", role: "link" }),
		);
		const listed = await s.result(
			call("page.list", { kind: "links", limit: 50 }),
		);
		const spoonFromFind = found.candidates?.[0]?.item;
		const spoonFromList = listed.list?.entries.find(
			(e) => e.title === "木のスプーン",
		)?.item;
		expect(spoonFromFind).toBeDefined();
		expect(spoonFromFind).toBe(spoonFromList);
		expect(spoonFromFind).toBe(
			s.summary.items.find((i) => i.name === "木のスプーン")?.item,
		);
	});

	test("after a click the next page gets a new page id", async () => {
		const s = await setup();
		const first = s.summary.page;
		const r = await s.result(
			call("item.open", { item: idOf(s.summary.items, "link", "全商品") }),
		);
		expect(r.page?.page).not.toBe(first);
	});
});

describe("item.open", () => {
	test("opens the page behind a link", async () => {
		const s = await setup();
		const r = await s.result(
			call("item.open", { item: idOf(s.summary.items, "link", "全商品") }),
		);
		expect(r.status).toBe("completed");
		expect(r.page?.title).toBe("全商品 | 楓雑貨店");
	});

	test("a click that opens a new tab follows to it: the summary is the new page and later parts work there", async () => {
		const s = await setup({ start: HOSHI });
		const r = await s.result(
			call("item.open", { item: idOf(s.summary.items, "link", "ご利用案内") }),
		);
		expect(r.status).toBe("completed");
		expect(r.page?.title).toBe("ご利用案内 | 星屑堂書店");
		expect(s.adapter.url).toContain("guide.html");
		// The next part acts on the new tab, not the first one.
		const read = await s.result(
			call("page.read", { target: null, maxChars: 500 }),
		);
		expect(read.read?.url).toContain("guide.html");
		expect(s.tabs.open()).toHaveLength(2);
	});

	test("a link with no destination of its own runs page script, so it asks first like a button (R05)", async () => {
		// The fake Hoshikuzu page lists its links without `/url`, as a script-driven link would be.
		const s = await setup({
			start: HOSHI,
			approver: new FixtureApprover({ decision: "deny" }),
		});
		const executed = await s.run(
			call("item.open", { item: idOf(s.summary.items, "link", "ホーム") }),
		);
		expect(executed).toMatchObject({
			kind: "outcome",
			outcome: { kind: "stop", code: "approval_denied" },
		});
		expect(s.adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
		]);
	});

	test("a menu item that is an <a href> opens without asking, though the snapshot gives it no /url (R18)", async () => {
		const s = await setup({
			start: `${BASE}sites/menu-demo/index.html`,
			approver: new FixtureApprover({ decision: "deny" }),
		});
		const r = await s.result(
			call("item.open", { item: idOf(s.summary.items, "menuitem", "設定") }),
		);
		expect(r.status).toBe("completed");
		expect(r.page?.title).toBe("設定 | デモ");
	});

	test("menu items without a destination of their own still ask first (R18)", async () => {
		for (const name of ["削除", "閉じる"]) {
			const s = await setup({
				start: `${BASE}sites/menu-demo/index.html`,
				approver: new FixtureApprover({ decision: "deny" }),
			});
			const executed = await s.run(
				call("item.open", { item: idOf(s.summary.items, "menuitem", name) }),
			);
			expect(executed).toMatchObject({
				kind: "outcome",
				outcome: { kind: "stop", code: "approval_denied" },
			});
			expect(s.adapter.dispatched.map((c) => c.action)).toEqual([
				"browser.navigate",
			]);
		}
	});

	test("a button needs the user's approval before it is clicked", async () => {
		const s = await setup({
			start: HOSHI,
			approver: new FixtureApprover({ decision: "deny" }),
		});
		const executed = await s.run(
			call("item.open", {
				item: idOf(s.summary.items, "button", "店舗の地図"),
			}),
		);
		expect(executed).toMatchObject({
			kind: "outcome",
			outcome: { kind: "stop", code: "approval_denied" },
		});
		expect(s.adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
		]);
		expect(s.recorder.events.map((e) => e.type)).toContain("part.result");
		expect(
			s.recorder.events.filter((e) => e.type === "part.result").at(-1),
		).toMatchObject({ status: "needs_approval", code: "approval_denied" });
	});
});

describe("page.wait", () => {
	test("waits for text or seconds and summarises", async () => {
		const s = await setup();
		const a = await s.result(
			call("page.wait", { text: "検索", seconds: null }),
		);
		const b = await s.result(call("page.wait", { text: null, seconds: 1 }));
		expect(a.status).toBe("completed");
		expect(b.page?.title).toBe("楓雑貨店");
		expect(s.adapter.dispatched.slice(-2)).toMatchObject([
			{ action: "page.wait", text: "検索" },
			{ action: "page.wait", seconds: 1 },
		]);
	});

	test("nothing to wait for is refused", async () => {
		const s = await setup();
		const r = await s.result(call("page.wait", { text: null, seconds: null }));
		expect(codes(r)).toEqual(["failed", "invalid_args"]);
	});
});

describe("page.read and page.list", () => {
	test("reads the page text, capped by maxChars", async () => {
		const s = await setup({ start: `${KAEDE}care.html` });
		const whole = await s.result(
			call("page.read", { target: null, maxChars: 5000 }),
		);
		expect(whole.read?.truncated).toBe(false);
		expect(whole.read?.text).toContain("手洗い");
		const cut = await s.result(
			call("page.read", { target: null, maxChars: 20 }),
		);
		expect(cut.read?.text.length).toBe(20);
		expect(cut.read).toMatchObject({ truncated: true });
		expect(cut.read!.charCount).toBeGreaterThan(20);
		expect(s.adapter.extracted.at(-1)).toEqual({
			targetRef: null,
			maxChars: 20,
		});
	});

	test("an item as the target is looked up again and handed to the extractor as a ref", async () => {
		const s = await setup({ start: `${KAEDE}care.html` });
		const found = await s.result(
			call("page.find", { text: "素材ごとの洗い方", role: "table" }),
		);
		const id = found.candidates?.[0]?.item;
		if (id === undefined) return;
		const r = await s.result(call("page.read", { target: id, maxChars: 500 }));
		expect(r.status).toBe("completed");
		expect(s.adapter.extracted.at(-1)?.targetRef).toMatch(/^e\d+$/);
	});

	test("lists results with their ids; an empty page has no entries", async () => {
		const s = await setup({ request: "「麻」を検索" });
		const searched = await s.result(
			call("site.search", {
				query: "麻",
				field: s.summary.items.find((i) => i.role === "searchbox")!.item,
			}),
		);
		const r = await s.result(
			call("page.list", {
				kind: "results",
				limit: 10,
				within: searched.page!.items.find((i) => i.role === "main")!.item,
			}),
		);
		expect(r.status).toBe("completed");
		expect(r.list?.entries.map((e) => e.title)).toEqual([
			"麻のふきん",
			"麻のエプロン",
		]);
		const care = await s.result(
			call("page.open", { url: `${KAEDE}ordered.html` }),
		);
		expect(care.status).toBe("completed");
		const none = await s.result(
			call("page.list", { kind: "table", limit: 10 }),
		);
		expect(codes(none)).toEqual(["failed", "no_entries"]);
	});
});

describe("page.capture", () => {
	test("saves a viewport capture under the run's directory with a host-made name", async () => {
		const s = await setup();
		const r = await s.result(
			call("page.capture", { range: "viewport", item: null }),
		);
		expect(r.status).toBe("completed");
		const capture = r.capture!;
		expect(capture.fileName).toBe(
			`${createHash("sha256").update(s.runId).digest("hex").slice(0, 12)}-1-viewport.png`,
		);
		expect(capture.fileName).not.toContain("/");
		expect(capture).toMatchObject({
			captureId: "c1",
			width: 64,
			height: 48,
			mediaType: "image/png",
		});
		expect(readdirSync(s.dir)).toEqual([capture.fileName]);
		const bytes = readFileSync(join(s.dir, capture.fileName));
		expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(JSON.stringify(r)).not.toContain(s.dir);
		expect(s.adapter.captured).toEqual([
			{ range: "viewport", targetRef: null },
		]);
		expect(
			s.recorder.events.find((e) => e.type === "capture.saved"),
		).toMatchObject({
			captureId: "c1",
			fileName: capture.fileName,
			width: 64,
			height: 48,
			range: "viewport",
			mediaType: "image/png",
		});
	});

	test("numbers each capture and names its range", async () => {
		const s = await setup();
		await s.result(call("page.capture", { range: "viewport", item: null }));
		const full = await s.result(
			call("page.capture", { range: "full", item: null }),
		);
		expect(full.capture).toMatchObject({ captureId: "c2", height: 192 });
		expect(full.capture?.fileName).toMatch(/-2-full\.png$/);
		expect(readdirSync(s.dir)).toHaveLength(2);
	});

	test("an element capture needs an item and uses its ref in a fresh observation", async () => {
		const s = await setup();
		const missing = await s.result(
			call("page.capture", { range: "item", item: null }),
		);
		expect(codes(missing)).toEqual(["failed", "item_required"]);
		const r = await s.result(
			call("page.capture", {
				range: "item",
				item: idOf(s.summary.items, "searchbox", "商品名・素材"),
			}),
		);
		expect(r.status).toBe("completed");
		expect(s.adapter.captured.at(-1)?.targetRef).toMatch(/^e\d+$/);
		expect(r.capture?.fileName).toMatch(/-1-item\.png$/);
	});

	describe("what the captured range holds (design R24, F11)", () => {
		// "Only the product part" of a product page: the intended block is the article, which must hold the name and
		// the photo and not the recommendations beside it. The page summary says which block holds what, and the
		// capture reports what it took, so the range can be chosen and then checked.
		const product = `${KAEDE}product.html?id=2`;
		const shoot = async (role: string, name: string) => {
			const s = await setup({ start: product });
			const r = await s.result(
				call("page.capture", {
					range: "item",
					item: idOf(s.summary.items, role, name),
				}),
			);
			const event = s.recorder.events.find((e) => e.type === "capture.saved");
			if (event?.type !== "capture.saved") throw new Error("no capture event");
			return { s, r, event };
		};
		const expected = async () => {
			const def = await devCase("dev-capture-item");
			if (def.expect.kind !== "reach") throw new Error("not a reach case");
			return def.expect.captures!.holds!;
		};

		test("the summary names the block each element sits in and what each block holds", async () => {
			const s = await setup({ start: product });
			const at = (role: string, name: string) =>
				s.summary.items.find((i) => i.role === role && i.name === name)!;
			expect(at("article", "商品の詳細").holds).toEqual([
				"heading 木のスプーン",
				"img 商品の写真",
			]);
			expect(at("img", "商品の写真").block).toBe("article 商品の詳細");
			expect(at("link", "陶器の小皿").block).toBeUndefined();
			expect(at("link", "陶器の小皿").region).toBe("complementary おすすめ");
			// The whole main region holds the article and the recommendations: not the smallest block.
			const main = s.summary.items.find((i) => i.role === "main")!;
			expect(main.holds).toEqual(
				expect.arrayContaining([
					"article 商品の詳細",
					"complementary おすすめ",
					"img 商品の写真",
				]),
			);
		});

		test("the article capture reports its target and what it holds; the scorer finds the range right", async () => {
			const { r, event } = await shoot("article", "商品の詳細");
			expect(r.capture).toMatchObject({
				target: "article 商品の詳細",
				holds: ["heading 木のスプーン", "img 商品の写真"],
			});
			expect(r.capture?.holdsCount).toBeUndefined();
			expect(captureRangeScore(event, await expected())).toEqual({
				missing: [],
				extra: [],
				unconfirmed: false,
				ok: true,
			});
		});

		test("the whole main region is told apart from the article: it takes the recommendations too", async () => {
			const { r, event } = await shoot("main", "");
			expect(r.capture?.holds).toEqual(
				expect.arrayContaining([
					"article 商品の詳細",
					"complementary おすすめ",
				]),
			);
			const score = captureRangeScore(event, await expected());
			expect(score.ok).toBe(false);
			expect(score.missing).toEqual([]);
			expect(score.extra.map((e) => e.name)).toContain("おすすめ");
		});

		test("the photo alone leaves out the name; before this change no capture could be confirmed", async () => {
			const { r, event } = await shoot("img", "商品の写真");
			expect(r.capture?.holds).toBeUndefined();
			const score = captureRangeScore(event, await expected());
			expect(score.missing.map((e) => e.name)).toEqual([
				"木のスプーン",
				"商品の写真",
			]);
			// The old record: a target and no content. Everything wanted is unconfirmed.
			const { holds: _holds, holdsCount: _count, ...before } = event;
			const old = captureRangeScore(before, await expected());
			expect(old).toMatchObject({ unconfirmed: true, ok: false });
			expect(old.missing).toHaveLength(2);
		});

		test("page text in the report stays under the capture member (marked untrusted by the core)", async () => {
			const { r } = await shoot("article", "商品の詳細");
			const keys = Object.keys(r).filter((k) =>
				JSON.stringify(r[k as keyof PartResult]).includes("木のスプーン"),
			);
			expect(keys).toEqual(["capture"]);
		});
	});

	test("a capture the adapter refuses is a failure with its code, and nothing is saved", async () => {
		const s = await setup();
		s.adapter.captureError = new AdapterError("capture_failed", false);
		const r = await s.result(
			call("page.capture", { range: "viewport", item: null }),
		);
		expect(codes(r)).toEqual(["failed", "capture_failed"]);
		expect(readdirSync(s.dir)).toEqual([]);
	});

	test("an image that is not an image is not saved", async () => {
		const s = await setup();
		s.adapter.captureImage = {
			mediaType: "image/png",
			bytes: new Uint8Array([1, 2, 3]),
			width: 1,
			height: 1,
		};
		const r = await s.result(
			call("page.capture", { range: "viewport", item: null }),
		);
		expect(codes(r)).toEqual(["failed", "capture_invalid_image"]);
		expect(readdirSync(s.dir)).toEqual([]);
		expect(s.recorder.events.some((e) => e.type === "capture.saved")).toBe(
			false,
		);
	});
});

const ORDER = `${KAEDE}order.html`;
const orderRequest =
	"楓雑貨店で注文をお願いします。お名前は中村美咲、メールアドレスは misaki@example.com、商品は木のスプーン、ギフト包装あり、お届けはお急ぎ便でお願いします。";

describe("form.inspect and form.fill", () => {
	test("lists the fields with their kinds, options and whether they are filled, and the submit button", async () => {
		const s = await setup({ start: ORDER, request: orderRequest });
		const r = await s.result(call("form.inspect", { form: null }));
		expect(r.status).toBe("completed");
		const byLabel = new Map(r.form?.fields.map((f) => [f.label, f]));
		expect(byLabel.get("お名前")).toMatchObject({
			kind: "textbox",
			required: true,
			filled: false,
		});
		expect(byLabel.get("商品")?.options).toContain("木のスプーン");
		expect(byLabel.get("ギフト包装にする")).toMatchObject({
			kind: "checkbox",
			filled: false,
		});
		expect(byLabel.get("お急ぎ便")).toMatchObject({ kind: "radio" });
		expect(r.form?.submit.map((b) => b.name)).toContain("注文する");
	});

	test("fills text, a select, a checkbox and a radio by their ids; each field is reported", async () => {
		const s = await setup({ start: ORDER, request: orderRequest });
		const form = await s.result(call("form.inspect", { form: null }));
		const id = (label: string) =>
			form.form!.fields.find((f) => f.label === label)!.item;
		const r = await s.result(
			call("form.fill", {
				fields: [
					{ item: id("お名前"), value: "中村美咲" },
					{ item: id("メールアドレス"), value: "misaki@example.com" },
					{ item: id("商品"), value: "木のスプーン" },
					{ item: id("ギフト包装にする"), value: "on" },
					{ item: id("お急ぎ便"), value: "on" },
				],
			}),
		);
		expect(r.status).toBe("completed");
		expect(r.fill?.map((f) => f.status)).toEqual(Array(5).fill("filled"));
		expect(s.adapter.dispatched.slice(1).map((c) => c.action)).toEqual([
			"page.fill",
			"page.fill",
			"page.select",
			"page.click",
			"page.click",
		]);
		// One ledger row per inner operation.
		expect(s.operations()).toHaveLength(5);
		const again = await s.result(call("form.inspect", { form: null }));
		const state = new Map(again.form?.fields.map((f) => [f.label, f.filled]));
		expect(state.get("お名前")).toBe(true);
		expect(state.get("ギフト包装にする")).toBe(true);
		expect(state.get("お急ぎ便")).toBe(true);
		expect(state.get("通常便")).toBe(false);
	});

	test("a value the request does not show is not typed: the field needs input", async () => {
		const s = await setup({ start: ORDER, request: orderRequest });
		const form = await s.result(call("form.inspect", { form: null }));
		const name = form.form!.fields.find((f) => f.label === "お名前")!.item;
		const mail = form.form!.fields.find(
			(f) => f.label === "メールアドレス",
		)!.item;
		const r = await s.result(
			call("form.fill", {
				fields: [
					{ item: name, value: "山田太郎" },
					{ item: mail, value: "misaki@example.com" },
				],
			}),
		);
		expect(codes(r)).toEqual(["partial", "value_source"]);
		expect(r.fill).toEqual([
			{ item: name, status: "needs_input", code: "value_source" },
			{ item: mail, status: "filled" },
		]);
		expect(
			s.adapter.dispatched.some(
				(c) => c.action === "page.fill" && c.text === "山田太郎",
			),
		).toBe(false);
		expect(s.adapter.field("e21")).toBe("");
	});

	test("a value the user approved for this site is typed", async () => {
		const s = await setup({ start: ORDER, request: orderRequest });
		s.grants.approve({ value: "山田太郎", origin: BASE, purpose: "お名前" });
		const form = await s.result(call("form.inspect", { form: null }));
		const name = form.form!.fields.find((f) => f.label === "お名前")!.item;
		const r = await s.result(
			call("form.fill", { fields: [{ item: name, value: "山田太郎" }] }),
		);
		expect(r.status).toBe("completed");
		expect(s.adapter.field("e21")).toBe("山田太郎");
	});

	test("a value approved for one field is not typed into another field (R19)", async () => {
		const s = await setup({ start: ORDER, request: orderRequest });
		s.grants.approve({
			value: "山田太郎",
			origin: BASE,
			purpose: "メールアドレス",
		});
		const form = await s.result(call("form.inspect", { form: null }));
		const name = form.form!.fields.find((f) => f.label === "お名前")!.item;
		const r = await s.result(
			call("form.fill", { fields: [{ item: name, value: "山田太郎" }] }),
		);
		expect(codes(r)).toEqual(["failed", "value_source"]);
		expect(r.fill?.[0]).toMatchObject({ status: "needs_input" });
		expect(s.adapter.field("e21")).toBe("");
	});

	test("a select takes the option's visible label; another text is refused", async () => {
		const s = await setup({ start: ORDER, request: orderRequest });
		const form = await s.result(call("form.inspect", { form: null }));
		const item = form.form!.fields.find((f) => f.label === "商品")!.item;
		const r = await s.result(
			call("form.fill", { fields: [{ item, value: "木の匙" }] }),
		);
		expect(codes(r)).toEqual(["failed", "option_not_found"]);
		expect(s.adapter.dispatched.some((c) => c.action === "page.select")).toBe(
			false,
		);
	});

	test("a choice needs a reason in the request; clearing a box needs none; a radio is not cleared", async () => {
		const s = await setup({
			start: ORDER,
			request:
				"楓雑貨店で木のスプーンを注文してください。ギフト包装は要りません。",
		});
		const form = await s.result(call("form.inspect", { form: null }));
		const id = (label: string) =>
			form.form!.fields.find((f) => f.label === label)!.item;
		const radio = await s.result(
			call("form.fill", { fields: [{ item: id("通常便"), value: "true" }] }),
		);
		expect(codes(radio)).toEqual(["failed", "value_source"]);
		expect(radio.fill?.[0]?.status).toBe("needs_input");
		const clear = await s.result(
			call("form.fill", { fields: [{ item: id("お急ぎ便"), value: "false" }] }),
		);
		expect(clear.fill?.[0]).toMatchObject({
			status: "refused",
			code: "cannot_uncheck",
		});
		// Clearing a box that is not checked changes nothing and is done.
		const off = await s.result(
			call("form.fill", {
				fields: [{ item: id("ギフト包装にする"), value: "false" }],
			}),
		);
		expect(off.status).toBe("completed");
		expect(
			s.adapter.dispatched.filter((c) => c.action === "page.click"),
		).toHaveLength(0);
	});

	test("a button is not a field", async () => {
		const s = await setup({ start: ORDER, request: orderRequest });
		const r = await s.result(
			call("form.fill", {
				fields: [
					{
						item: idOf(s.summary.items, "button", "注文する"),
						value: "注文する",
					},
				],
			}),
		);
		expect(codes(r)).toEqual(["failed", "unsupported_field"]);
	});
});

describe("form.submit", () => {
	test("is asked first: a denial sends nothing and stops the run", async () => {
		const s = await setup({
			start: ORDER,
			request: orderRequest,
			approver: new FixtureApprover({ decision: "deny" }),
		});
		const executed = await s.run(
			call("form.submit", {
				button: idOf(s.summary.items, "button", "注文する"),
			}),
		);
		expect(executed).toMatchObject({
			kind: "outcome",
			outcome: { kind: "stop", code: "approval_denied" },
		});
		expect(s.adapter.dispatched.some((c) => c.action === "page.click")).toBe(
			false,
		);
		expect(s.recorder.events.some((e) => e.type === "approval.requested")).toBe(
			true,
		);
		expect(s.operations().map((o) => o.status)).toEqual(["failed"]);
	});

	test("a granted submission is sent and the page after it is summarised", async () => {
		const s = await setup({ start: ORDER, request: orderRequest });
		const form = await s.result(call("form.inspect", { form: null }));
		const id = (label: string) =>
			form.form!.fields.find((f) => f.label === label)!.item;
		await s.result(
			call("form.fill", {
				fields: [
					{ item: id("お名前"), value: "中村美咲" },
					{ item: id("メールアドレス"), value: "misaki@example.com" },
				],
			}),
		);
		const r = await s.result(
			call("form.submit", { button: form.form!.submit[0]!.item }),
		);
		expect(r.status).toBe("completed");
		expect(r.page?.url).toContain("ordered.html");
		expect(s.adapter.url).toContain("fullname=%E4%B8%AD%E6%9D%91");
		const approvals = s.recorder.events.filter(
			(e) => e.type === "approval.answered",
		);
		expect(approvals).toHaveLength(1);
		expect(s.operations().at(-1)).toMatchObject({ status: "confirmed" });
	});
});

describe("an operation whose outcome is not known", () => {
	test("the part is indeterminate, the run stops, and nothing is sent again", async () => {
		const s = await setup();
		s.adapter.onDispatch = (command) =>
			command.action === "page.click"
				? { status: "indeterminate", code: "transport_lost", retryable: false }
				: undefined;
		const executed = await s.run(
			call("item.open", { item: idOf(s.summary.items, "link", "全商品") }),
		);
		expect(executed).toEqual({
			kind: "end",
			status: "indeterminate",
			code: "transport_lost",
		});
		expect(
			s.recorder.events.filter((e) => e.type === "part.result").at(-1),
		).toMatchObject({
			part: "item.open",
			status: "indeterminate",
			code: "transport_lost",
		});
		const sent = s.adapter.dispatched.length;
		const next = await s.run(
			call("page.open", { url: `${KAEDE}catalog.html` }),
		);
		expect(next).toMatchObject({ kind: "end", status: "indeterminate" });
		expect(s.adapter.dispatched.length).toBe(sent);
		expect(s.operations().map((o) => o.status)).toEqual(["indeterminate"]);
	});
});

describe("what the transcript keeps of a part", () => {
	test("its name and argument names; never a value", async () => {
		const s = await setup({ request: "「麻」を検索" });
		await s.result(call("site.search", { query: "麻" }));
		const events = s.recorder.events.filter((e) => e.type.startsWith("part."));
		expect(events).toMatchObject([
			{ type: "part.call", part: "site.search", args: ["query"] },
			{ type: "part.result", part: "site.search", status: "completed" },
		]);
		expect(JSON.stringify(events)).not.toContain("麻");
	});

	test("no image and no path in the record", async () => {
		const s = await setup();
		await s.result(call("page.capture", { range: "viewport", item: null }));
		const text = JSON.stringify(s.recorder.events);
		expect(text).not.toContain(s.dir);
		expect(existsSync(s.dir)).toBe(true);
	});
});

describe("review fixes (S2b)", () => {
	test("a select takes the one option that contains the request's words, and only a choice the request makes", async () => {
		const s = await setup({ start: ORDER, request: orderRequest });
		const form = await s.result(call("form.inspect", { form: null }));
		const item = form.form!.fields.find((f) => f.label === "商品")!.item;
		// 「スプーン」 is in the request and in one option only.
		const one = await s.result(
			call("form.fill", { fields: [{ item, value: "スプーン" }] }),
		);
		expect(one.status).toBe("completed");
		expect(s.adapter.dispatched.at(-1)).toMatchObject({
			action: "page.select",
			values: ["木のスプーン"],
		});
		// An option the request never names is not chosen on the model's word.
		const other = await s.result(
			call("form.fill", { fields: [{ item, value: "陶器の小皿" }] }),
		);
		expect(other.fill?.[0]).toMatchObject({
			status: "needs_input",
			code: "value_source",
		});
	});

	test("a GET form's submit button opened by item.open asks first, as form.submit does", async () => {
		const s = await setup({
			start: `${BASE}sites/minato-hall/base/mail.html`,
			approver: new FixtureApprover({ decision: "deny" }),
		});
		const executed = await s.run(
			call("item.open", {
				item: idOf(s.summary.items, "button", "配信を停止する"),
			}),
		);
		expect(executed).toMatchObject({
			kind: "outcome",
			outcome: { kind: "stop", code: "approval_denied" },
		});
		expect(s.adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
		]);
		expect(s.adapter.url).toContain("mail.html");
	});

	test("a field is not opened: item.open leaves it to form.fill", async () => {
		const s = await setup({ start: ORDER, request: orderRequest });
		const form = await s.result(call("form.inspect", { form: null }));
		const gift = form.form!.fields.find(
			(f) => f.label === "ギフト包装にする",
		)!.item;
		const r = await s.result(call("item.open", { item: gift }));
		expect(codes(r)).toEqual(["failed", "item_not_openable"]);
		expect(
			s.adapter.dispatched.filter((c) => c.action === "page.click"),
		).toHaveLength(0);
	});

	test("an id issued before the content moved keeps naming its element; the next batch gets a new page id", async () => {
		let banner = false;
		const shifted = (body: string) =>
			banner ? `- link "お知らせ" [ref=e900]\n${body}` : body;
		const core: PartsHelpers = {
			summarizePage: (raw, o) =>
				partsHelpers.summarizePage({ ...raw, body: shifted(raw.body) }, o),
			resolveItem: (r, body) => partsHelpers.resolveItem(r, shifted(body)),
			findItems: (body, p, q, l) =>
				partsHelpers.findItems(shifted(body), p, q, l),
			listEntries: (body, p, k, l) =>
				partsHelpers.listEntries(shifted(body), p, k, l),
			formFields: (body, p, f) => partsHelpers.formFields(shifted(body), p, f),
		};
		const s = await setup({ core });
		const all = idOf(s.summary.items, "link", "全商品");
		// A banner appears above everything: document-order numbers move by one.
		banner = true;
		const found = await s.result(
			call("page.find", { text: null, role: "link" }),
		);
		expect(found.status).toBe("completed");
		expect(
			found.candidates!.every((c) => !c.item.startsWith(`${s.summary.page}.`)),
		).toBe(true);
		expect(idOf(found.candidates, "link", "全商品")).not.toBe(all);
		// The old id still names 全商品, not the element that now has its number.
		const r = await s.result(call("item.open", { item: all }));
		expect(r.status).toBe("completed");
		expect(r.page?.title).toBe("全商品 | 楓雑貨店");
		expect(s.adapter.dispatched.at(-1)).toMatchObject({
			action: "page.click",
			element: 'link "全商品"',
		});
	});

	test("a click that went through but whose page cannot be looked at is partial, not failed", async () => {
		const s = await setup();
		s.adapter.onDispatch = (command, b) => {
			if (command.action === "page.click")
				b.observeError = new AdapterError("observe_failed", false);
			return undefined;
		};
		const r = await s.result(
			call("item.open", { item: idOf(s.summary.items, "link", "全商品") }),
		);
		expect(r.status).toBe("partial");
		expect(r.code).toBeDefined();
		expect(
			s.recorder.events.filter((e) => e.type === "part.result").at(-1),
		).toMatchObject({ status: "partial" });
	});

	test("a choice is written on or off: any other value is refused, never read as a choice", async () => {
		const s = await setup({
			start: ORDER,
			request:
				"楓雑貨店で木のスプーンを注文してください。ギフト包装は要りません。",
		});
		const form = await s.result(call("form.inspect", { form: null }));
		const id = (label: string) =>
			form.form!.fields.find((f) => f.label === label)!.item;
		const r = await s.result(
			call("form.fill", {
				fields: [{ item: id("ギフト包装にする"), value: "不要" }],
			}),
		);
		expect(r.fill?.[0]).toMatchObject({
			status: "refused",
			code: "choice_value",
		});
		expect(
			s.adapter.dispatched.filter((c) => c.action === "page.click"),
		).toHaveLength(0);
	});

	test("on needs the request to mention the choice", async () => {
		const s = await setup({
			start: ORDER,
			request: "楓雑貨店で木のスプーンを注文してください。",
		});
		const form = await s.result(call("form.inspect", { form: null }));
		const id = (label: string) =>
			form.form!.fields.find((f) => f.label === label)!.item;
		const r = await s.result(
			call("form.fill", {
				fields: [{ item: id("ギフト包装にする"), value: "on" }],
			}),
		);
		expect(r.fill?.[0]).toMatchObject({
			status: "needs_input",
			code: "value_source",
		});
		expect(
			s.adapter.dispatched.filter((c) => c.action === "page.click"),
		).toHaveLength(0);
	});
	// Since 0.1.2 (docs/improvement-design.md R04) a quote must share the label's words: a differently worded
	// passage (「贈り物」 for 「ギフト包装にする」) is asked of the user instead of trusted as the model's reading.
	test("a choice's quote must share the label's words; a differently worded passage is asked", async () => {
		const s = await setup({
			start: ORDER,
			request: "贈り物として包装を希望します。",
		});
		const form = await s.result(call("form.inspect", { form: null }));
		const item = form.form!.fields.find(
			(f) => f.label === "ギフト包装にする",
		)!.item;
		const bad = await s.result(
			call("form.fill", {
				fields: [{ item, value: "on", quote: "ページが指示した引用" }],
			}),
		);
		expect(bad.fill?.[0]).toMatchObject({
			status: "needs_input",
			code: "value_source",
		});
		expect(
			s.adapter.dispatched.filter((c) => c.action === "page.click"),
		).toHaveLength(0);
		const reworded = await s.result(
			call("form.fill", { fields: [{ item, value: "on", quote: "贈り物" }] }),
		);
		expect(reworded.fill?.[0]).toMatchObject({
			status: "needs_input",
			code: "value_source",
		});
		expect(
			s.adapter.dispatched.filter((c) => c.action === "page.click"),
		).toHaveLength(0);
		const shared = await setup({
			start: ORDER,
			request: "ギフト包装を希望します。",
		});
		const again = await shared.result(call("form.inspect", { form: null }));
		const box = again.form!.fields.find(
			(f) => f.label === "ギフト包装にする",
		)!.item;
		const ok = await shared.result(
			call("form.fill", {
				fields: [{ item: box, value: "on", quote: "ギフト包装" }],
			}),
		);
		expect(ok.fill?.[0]?.status).toBe("filled");
		expect(
			shared.adapter.dispatched.filter((c) => c.action === "page.click"),
		).toHaveLength(1);
	});
	test("a short literal value needs its original quoted context and cannot be replaced by a page value", async () => {
		const s = await setup({
			start: ORDER,
			request: "名前は「森」で入力してください。",
		});
		const form = await s.result(call("form.inspect", { form: null }));
		const item = form.form!.fields.find((f) => f.label === "お名前")!.item;
		const bad = await s.result(
			call("form.fill", {
				fields: [{ item, value: "外部秘密値", quote: "名前は「森」" }],
			}),
		);
		expect(bad.fill?.[0]?.status).toBe("needs_input");
		const ok = await s.result(
			call("form.fill", {
				fields: [{ item, value: "森", quote: "名前は「森」" }],
			}),
		);
		expect(ok.fill?.[0]?.status).toBe("filled");
	});

	test("a page that left the allowed sites while the image was taken is refused and nothing is saved", async () => {
		const s = await setup();
		const capture = s.adapter.capture.bind(s.adapter);
		s.adapter.capture = async (range, targetRef) => {
			const image = await capture(range, targetRef);
			s.adapter.setTabUrl(0, "https://evil.example/");
			return image;
		};
		const r = await s.result(
			call("page.capture", { range: "viewport", item: null }),
		);
		expect(r.status).toBe("failed");
		expect(readdirSync(s.dir)).toEqual([]);
	});

	test("an element capture records the target's role and a digest of its name, never the name", async () => {
		const s = await setup({ start: `${KAEDE}product.html?id=2` });
		const article = idOf(s.summary.items, "article", "商品の詳細");
		const r = await s.result(
			call("page.capture", { range: "item", item: article }),
		);
		expect(r.status).toBe("completed");
		const saved = s.recorder.events.find((e) => e.type === "capture.saved");
		expect(saved).toMatchObject({
			range: "item",
			target: { role: "article", nameHash: captureTargetHash("商品の詳細") },
		});
		expect(JSON.stringify(saved)).not.toContain("商品の詳細");
	});
});

describe("model-classified waiting pages (F09)", () => {
	test("a title alone cannot block reading; the model can block inputs while retaining observation tools", async () => {
		const s = await setup({ start: `${KAEDE}catalog.html` });
		(s.adapter as unknown as { tabs: { title: string }[] }).tabs[0]!.title =
			"Just a moment...";
		expect(
			(await s.result(call("page.list", { kind: "links", limit: 5 }))).status,
		).toBe("completed");
		await s.result(
			call("page.wait", { text: null, seconds: 0.1, condition: "blocked" }),
		);
		const item = s.summary.items.find((i) => i.role === "link")!.item;
		expect((await s.result(call("item.open", { item }))).code).toBe(
			"site_blocked",
		);
		expect(
			(await s.result(call("page.find", { text: null, role: "link" }))).status,
		).toBe("completed");
		await s.result(
			call("page.wait", { text: null, seconds: 0.1, condition: "ready" }),
		);
		expect((await s.result(call("item.open", { item }))).code).not.toBe(
			"site_blocked",
		);
	});
});
