import {
	AdapterError,
	COMMON_ACTIONS,
	type AdapterCommand,
	type AdapterDispatchResult,
	type AdapterState,
	type CapturedImage,
	type AdapterTarget,
	type CatalogEntry,
	type ExtractedContent,
	type FixedInspection,
	type InspectionResult,
	type PlatformAdapter,
	type RawObservation,
} from "eumenes-interact";

/**
 * An in-memory browser for host tests: a few fixture-like pages with ARIA snapshot text, URL transitions per
 * command, tabs. No process, no network, no port.
 */

import { deflateSync } from "node:zlib";

const CRC = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
	const body = new Uint8Array(4 + data.length);
	body.set(new TextEncoder().encode(type));
	body.set(data, 4);
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(body, 4);
	view.setUint32(8 + data.length, crc32(body));
	return out;
};

/** A real, small PNG (grey) of the given size, for `capture`. */
export function makePng(width: number, height: number): Uint8Array {
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header.set([8, 0, 0, 0, 0], 8);
	const row = new Uint8Array(1 + width).fill(0x80);
	row[0] = 0;
	const raw = new Uint8Array(row.length * height);
	for (let y = 0; y < height; y++) raw.set(row, y * row.length);
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", new Uint8Array()),
	];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

export const BASE = "http://127.0.0.1:41234/";

export type PageDef = {
	title: string;
	/** ARIA snapshot lines, with `[ref=eN]` on the elements. */
	lines: string[];
	/** What a click on a ref does: returns the URL to go to, or opens a tab itself. */
	click?: Record<string, (b: FakeBrowser) => string | undefined>;
	/** The element a filled field with `submit` presses. */
	submitRef?: string;
	info?: Record<string, InspectionResult>;
	/** The page's main text, as `extract` returns it (default: its snapshot lines). */
	text?: string;
};

type Tab = { url: string; title: string };

const GET_SUBMIT: InspectionResult = {
	tag: "button",
	type: "submit",
	inForm: true,
	formMethod: "get",
	submits: true,
};
const PLAIN_BUTTON: InspectionResult = {
	tag: "button",
	type: "button",
	inForm: false,
	submits: false,
};
const LINK: InspectionResult = { tag: "a", inForm: false, submits: false };

/** The pages of the fake site, by path under `BASE`. */
function wiki(url: URL, b: FakeBrowser): PageDef | null {
	const at = (rest: string) => new URL(rest, url).href;
	const search: PageDef["lines"] = [
		"- banner [ref=e1]:",
		'  - searchbox "Wikipedia内を検索" [ref=e2]',
	];
	const article = "/wiki/%E6%A9%9F%E6%A2%B0%E5%AD%A6%E7%BF%92";
	if (url.pathname === "/")
		return {
			title: "Wikipedia",
			lines: [
				...search,
				"- main [ref=e3]:",
				'  - heading "Wikipedia" [level=1] [ref=e4]',
				'  - button "メニュー" [ref=e5]',
			],
			submitRef: "e2",
			click: {
				e5: () => at("/"),
				e2: () =>
					b.field("e2") === "機械学習"
						? at(article)
						: at(`/w/index.php?search=${encodeURIComponent(b.field("e2"))}`),
			},
			info: { e2: GET_SUBMIT, e5: PLAIN_BUTTON },
		};
	if (url.pathname === "/w/index.php")
		return {
			title: "検索結果 - Wikipedia",
			lines: [
				...search,
				"- main [ref=e3]:",
				'  - link "ヘルプ" [ref=e4]:',
				"    - /url: /wiki/Help:%E6%A4%9C%E7%B4%A2",
				'  - link "特別ページ" [ref=e5]:',
				"    - /url: /wiki/%E7%89%B9%E5%88%A5:%E6%A4%9C%E7%B4%A2",
				'  - link "赤リンク" [ref=e6]:',
				"    - /url: /w/index.php?title=X&action=edit&redlink=1",
				"  - link [ref=e7]:",
				`    - /url: ${article}`,
				'  - link "機械学習" [ref=e8]:',
				`    - /url: ${article}`,
				'  - link "人工知能" [ref=e9]:',
				"    - /url: /wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD",
			],
			click: {
				e8: () => at(article),
				e9: () => at("/wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD"),
			},
			info: { e4: LINK, e8: LINK, e9: LINK },
		};
	if (url.pathname.startsWith("/wiki/"))
		return {
			title: "機械学習 - Wikipedia",
			lines: [
				...search,
				"- main [ref=e3]:",
				'  - heading "機械学習" [level=1] [ref=e4]',
				"  - paragraph [ref=e5]: 機械学習は、データから学習するアルゴリズムの研究分野である。",
			],
			text: "機械学習は、データから学習するアルゴリズムの研究分野である。",
			info: { e2: GET_SUBMIT },
			submitRef: "e2",
			click: { e2: () => at("/w/index.php?search=x") },
		};
	return null;
}

const INPUT: InspectionResult = {
	tag: "input",
	inForm: true,
	submits: false,
	formMethod: "get",
};

const PRODUCTS: Record<string, { name: string; material: string }> = {
	"1": { name: "麻のふきん", material: "麻" },
	"2": { name: "木のスプーン", material: "桜の木" },
	"3": { name: "陶器の小皿", material: "磁器" },
	"4": { name: "綿のポーチ", material: "綿" },
	"5": { name: "麻のエプロン", material: "麻" },
	"6": { name: "木のまな板", material: "ひのき" },
};

/** The shop fixture (`sites/kaede-shop/base`): search, results, a product, the catalog, a table and an order form. */
function kaede(url: URL, b: FakeBrowser): PageDef | null {
	const page = url.pathname.split("/").at(-1);
	const base = new URL("./", url).href;
	const at = (rest: string) => new URL(rest, base).href;
	const header = [
		"- banner [ref=e1]:",
		'  - link "楓雑貨店" [ref=e2]:',
		"    - /url: index.html",
		'  - navigation "メイン" [ref=e3]:',
		'    - link "ホーム" [ref=e4]:',
		"      - /url: index.html",
		'    - link "全商品" [ref=e5]:',
		"      - /url: catalog.html",
		'    - link "お手入れガイド" [ref=e6]:',
		"      - /url: care.html",
		'    - link "ご注文フォーム" [ref=e7]:',
		"      - /url: order.html",
	];
	const nav: PageDef["click"] = {
		e2: () => at("index.html"),
		e4: () => at("index.html"),
		e5: () => at("catalog.html"),
		e6: () => at("care.html"),
		e7: () => at("order.html"),
	};
	const navInfo = { e2: LINK, e4: LINK, e5: LINK, e6: LINK, e7: LINK };
	const link = (ref: number, name: string, id: string, indent = "  ") => [
		`${indent}- link "${name}" [ref=e${ref}]:`,
		`${indent}  - /url: product.html?id=${id}`,
	];
	switch (page) {
		case "index.html":
			return {
				title: "楓雑貨店",
				lines: [
					...header,
					"- main [ref=e8]:",
					'  - heading "楓雑貨店" [level=1] [ref=e9]',
					"  - paragraph [ref=e10]: 暮らしの小物を、ひとつずつ手づくりで。",
					"  - search [ref=e11]:",
					'    - searchbox "商品名・素材" [ref=e12]',
					'    - button "検索" [ref=e13]',
				],
				submitRef: "e13",
				click: {
					...nav,
					e13: () => at(`results.html?q=${encodeURIComponent(b.field("e12"))}`),
				},
				info: { ...navInfo, e12: GET_SUBMIT, e13: GET_SUBMIT },
			};
		case "results.html": {
			const q = url.searchParams.get("q") ?? "";
			const hits = Object.entries(PRODUCTS).filter(([, p]) =>
				(p.name + p.material).includes(q),
			);
			return {
				title: "検索結果 | 楓雑貨店",
				lines: [
					...header,
					"- main [ref=e8]:",
					'  - heading "検索結果" [level=1] [ref=e9]',
					`  - paragraph [ref=e10]: 「${q}」: ${hits.length}件`,
					"  - list [ref=e11]:",
					...hits.flatMap(([id, p], i) => [
						"    - listitem:",
						...link(20 + i, p.name, id, "      "),
					]),
				],
				click: {
					...nav,
					...Object.fromEntries(
						hits.map(([id], i) => [
							`e${20 + i}`,
							() => at(`product.html?id=${id}`),
						]),
					),
				},
				info: {
					...navInfo,
					...Object.fromEntries(hits.map((_, i) => [`e${20 + i}`, LINK])),
				},
			};
		}
		case "catalog.html": {
			const sections: [string, string[]][] = [
				["キッチン", ["1", "2", "3", "6"]],
				["ファッション", ["4", "5"]],
				["贈りもの", ["3", "4"]],
				["季節のおすすめ", ["1", "5"]],
				["新着", ["2", "6"]],
				["アウトレット", ["4"]],
			];
			let n = 20;
			const lines: string[] = [];
			const click: NonNullable<PageDef["click"]> = { ...nav };
			const info: Record<string, InspectionResult> = { ...navInfo };
			for (const [label, ids] of sections) {
				lines.push(`  - region "${label}" [ref=e${n++}]:`);
				lines.push(`    - heading "${label}" [level=2] [ref=e${n++}]`);
				for (const id of ids) {
					lines.push(...link(n, PRODUCTS[id]!.name, id, "    "));
					click[`e${n}`] = () => at(`product.html?id=${id}`);
					info[`e${n}`] = LINK;
					n++;
				}
			}
			return {
				title: "全商品 | 楓雑貨店",
				lines: [
					...header,
					"- main [ref=e8]:",
					'  - heading "全商品" [level=1] [ref=e9]',
					...lines,
				],
				click,
				info,
			};
		}
		case "product.html": {
			const id = url.searchParams.get("id") ?? "";
			const p = PRODUCTS[id];
			return {
				title: p ? `${p.name} | 楓雑貨店` : "楓雑貨店",
				lines: [
					...header,
					"- main [ref=e8]:",
					`  - article "商品の詳細" [ref=e9]:`,
					`    - heading "${p?.name ?? ""}" [level=1] [ref=e10]`,
					'    - img "商品の写真" [ref=e11]',
					`    - paragraph [ref=e12]: 素材: ${p?.material ?? ""}`,
					'  - complementary "おすすめ" [ref=e13]:',
					'    - heading "こちらもどうぞ" [level=2] [ref=e14]',
					...link(15, "陶器の小皿", "3", "    "),
					...link(16, "木のまな板", "6", "    "),
				],
				click: {
					...nav,
					e15: () => at("product.html?id=3"),
					e16: () => at("product.html?id=6"),
				},
				info: { ...navInfo, e15: LINK, e16: LINK },
			};
		}
		case "care.html":
			return {
				title: "お手入れガイド | 楓雑貨店",
				lines: [
					...header,
					"- main [ref=e8]:",
					'  - heading "お手入れガイド" [level=1] [ref=e9]',
					"  - paragraph [ref=e10]: 素材ごとの目安は下の表のとおりです。",
					'  - table "素材ごとの洗い方" [ref=e11]:',
					'    - row "綿 洗濯機（ネット使用） 40度":',
					'      - cell "綿"',
					'    - row "麻 手洗い 30度":',
					'      - cell "麻"',
				],
				text: "素材ごとの洗い方 綿 洗濯機（ネット使用） 40度 麻 手洗い 30度 ウール 中性洗剤で押し洗い 25度",
				click: nav,
				info: navInfo,
			};
		case "order.html": {
			const gift = b.field("e11") === "1";
			const delivery = b.field("e12");
			const item = b.field("e10");
			const options = [
				"選択してください",
				"麻のふきん",
				"木のスプーン",
				"陶器の小皿",
			];
			return {
				title: "ご注文 | 楓雑貨店",
				lines: [
					...header,
					"- main [ref=e8]:",
					'  - heading "ご注文フォーム" [level=1] [ref=e9]',
					"  - form [ref=e20]:",
					`    - textbox "お名前" [required] [ref=e21]${b.field("e21") ? `: ${b.field("e21")}` : ""}`,
					`    - textbox "メールアドレス" [required] [ref=e22]${b.field("e22") ? `: ${b.field("e22")}` : ""}`,
					'    - combobox "商品" [ref=e10]:',
					...options.map(
						(o) => `      - option "${o}"${o === item ? " [selected]" : ""}`,
					),
					`    - checkbox "ギフト包装にする"${gift ? " [checked]" : ""} [ref=e11]`,
					'    - group "お届け方法（必須）":',
					`      - radio "通常便"${delivery === "normal" ? " [checked]" : ""} [ref=e12]`,
					`      - radio "お急ぎ便"${delivery === "express" ? " [checked]" : ""} [ref=e13]`,
					'    - button "注文する" [ref=e14]',
				],
				click: {
					...nav,
					e11: () => {
						b.setField("e11", gift ? "" : "1");
						return undefined;
					},
					e12: () => {
						b.setField("e12", "normal");
						return undefined;
					},
					e13: () => {
						b.setField("e12", "express");
						return undefined;
					},
					e14: () => {
						const values: Record<string, string> = {
							木のスプーン: "spoon",
							麻のふきん: "cloth",
							陶器の小皿: "plate",
						};
						const query = new URLSearchParams({
							fullname: b.field("e21"),
							email: b.field("e22"),
							item: values[b.field("e10")] ?? "",
							...(gift ? { gift: "1" } : {}),
							delivery: b.field("e12"),
						});
						return at(`ordered.html?${query}`);
					},
				},
				info: {
					...navInfo,
					e11: INPUT,
					e12: INPUT,
					e13: INPUT,
					e14: GET_SUBMIT,
				},
			};
		}
		case "ordered.html":
			return {
				title: "ご注文を受け付けました | 楓雑貨店",
				lines: [
					...header,
					"- main [ref=e8]:",
					'  - heading "ご注文を受け付けました" [level=1] [ref=e9]',
				],
				click: nav,
				info: navInfo,
			};
		default:
			return null;
	}
}

function site(url: URL, b: FakeBrowser): PageDef | null {
	if (url.hostname.endsWith("wikipedia.org")) return wiki(url, b);
	if (url.pathname.startsWith("/sites/kaede-shop/base/")) return kaede(url, b);
	const path = url.pathname.slice(1);
	// A video site in the shape of a live page: the origin is whatever the test navigates to.
	const at = (rest: string) => new URL(rest, url).href;
	switch (path) {
		case "":
			return {
				title: "YouTube",
				lines: [
					"- banner [ref=e1]:",
					'  - combobox "検索" [ref=e2]',
					'  - button "検索" [ref=e3]',
				],
				submitRef: "e3",
				click: {
					e3: () =>
						at(`/results?search_query=${encodeURIComponent(b.field("e2"))}`),
				},
				info: { e2: GET_SUBMIT, e3: GET_SUBMIT },
			};
		case "results":
			return {
				title: "AI research - YouTube",
				lines: [
					"- main [ref=e1]:",
					'  - link "AI research のしくみ 12:34" [ref=e2]:',
					"    - /url: /watch?v=abc123",
					'  - link "AI research のしくみ" [ref=e3]:',
					"    - /url: /watch?v=abc123",
					'  - link "チャンネル" [ref=e4]:',
					"    - /url: /@channel",
					'  - link "別の動画" [ref=e5]:',
					"    - /url: /watch?v=def456",
				],
				click: {
					e2: () => at("/watch?v=abc123"),
					e3: () => at("/watch?v=abc123"),
					e5: () => at("/watch?v=def456"),
				},
				info: { e2: LINK, e3: LINK, e5: LINK },
			};
		case "watch":
			return {
				title: "AI research のしくみ - YouTube",
				lines: [
					"- main [ref=e1]:",
					'  - heading "AI research のしくみ" [level=1] [ref=e2]',
					'  - button "一時停止" [ref=e3]',
				],
			};
		case "sites/hoshikuzu/base/index.html":
			return {
				title: "星屑堂書店",
				lines: [
					"- banner [ref=e1]:",
					'  - link "星屑堂書店" [ref=e2]',
					'  - navigation "メイン" [ref=e3]:',
					'    - link "ホーム" [ref=e4]',
					'    - link "ご利用案内" [ref=e5]',
					'    - button "店舗の地図" [ref=e6]',
					"  - search [ref=e7]:",
					'    - searchbox "書名・著者" [ref=e8]',
					'    - button "検索" [ref=e9]',
					"- main [ref=e10]:",
					'  - heading "星屑堂書店" [level=1] [ref=e11]',
				],
				submitRef: "e9",
				click: {
					e4: () => `${BASE}sites/hoshikuzu/base/index.html`,
					e5: () => {
						b.openTab(`${BASE}sites/hoshikuzu/base/guide.html`);
						return undefined;
					},
					e6: () => {
						b.openTab(`${BASE}sites/hoshikuzu/base/map.html`);
						return undefined;
					},
					e9: () =>
						`${BASE}sites/hoshikuzu/base/results.html?q=${encodeURIComponent(b.field("e8"))}`,
				},
				info: {
					e4: LINK,
					e5: LINK,
					e6: PLAIN_BUTTON,
					e8: GET_SUBMIT,
					e9: GET_SUBMIT,
				},
			};
		case "sites/hoshikuzu/duplicate/index.html":
			return {
				title: "星屑堂書店",
				lines: [
					'- complementary "古書買取" [ref=e1]:',
					'  - heading "古書買取の査定" [level=2] [ref=e2]',
					"  - form [ref=e3]:",
					'    - searchbox "書名・著者" [ref=e4]',
					'    - button "検索" [ref=e5]',
					"- main [ref=e6]:",
					'  - heading "星屑堂書店" [level=1] [ref=e7]',
					'  - region "蔵書検索" [ref=e8]:',
					"    - search [ref=e9]:",
					'      - searchbox "書名・著者" [ref=e10]',
					'      - button "検索" [ref=e11]',
				],
				submitRef: "e11",
				click: {
					e5: () => `${BASE}sites/hoshikuzu/duplicate/decoy.html`,
					e11: () =>
						`${BASE}sites/hoshikuzu/duplicate/results.html?q=${encodeURIComponent(b.field("e10"))}`,
				},
				info: {
					e4: GET_SUBMIT,
					e5: GET_SUBMIT,
					e10: GET_SUBMIT,
					e11: GET_SUBMIT,
				},
			};
		case "sites/hoshikuzu/duplicate/results.html":
			return {
				title: "検索結果 | 星屑堂書店",
				lines: [
					"- main [ref=e1]:",
					'  - heading "検索結果" [level=1] [ref=e2]',
					'  - link "天野の本" [ref=e3]',
				],
				click: { e3: () => `${BASE}sites/hoshikuzu/duplicate/results.html` },
				info: { e3: LINK },
			};
		case "sites/hoshikuzu/duplicate/decoy.html":
			return {
				title: "買取の査定 | 星屑堂書店",
				lines: [
					"- main [ref=e1]:",
					'  - heading "買取の査定" [level=1] [ref=e2]',
				],
			};
		case "sites/hoshikuzu/base/results.html":
			return {
				title: "検索結果 | 星屑堂書店",
				lines: [
					"- main [ref=e1]:",
					'  - heading "検索結果" [level=1] [ref=e2]',
					"  - paragraph [ref=e3]: 「白波」: 1件",
					'  - link "月影の図書館" [ref=e4]',
				],
				click: { e4: () => `${BASE}sites/hoshikuzu/base/book.html?id=1` },
				info: { e4: LINK },
			};
		case "sites/hoshikuzu/base/guide.html":
			return {
				title: "ご利用案内 | 星屑堂書店",
				lines: [
					"- main [ref=e1]:",
					'  - heading "ご利用案内" [level=1] [ref=e2]',
				],
			};
		case "sites/hoshikuzu/base/map.html":
			return {
				title: "店舗の地図 | 星屑堂書店",
				lines: [
					"- main [ref=e1]:",
					'  - heading "店舗の地図" [level=1] [ref=e2]',
				],
			};
		case "sites/minato-hall/base/index.html":
			return {
				title: "みなと市民ホール",
				lines: [
					'- navigation "メイン" [ref=e1]:',
					// As in the fixture and a real snapshot: a link with a destination is a navigation (R05).
					'  - link "ホーム" [ref=e2]:',
					"    - /url: index.html",
					'  - link "見学の申し込み" [ref=e3]:',
					"    - /url: apply.html",
					'  - link "メールマガジン" [ref=e4]:',
					"    - /url: mail.html",
				],
				click: {
					e3: () => `${BASE}sites/minato-hall/base/apply.html`,
					e4: () => `${BASE}sites/minato-hall/base/mail.html`,
				},
				info: { e3: LINK, e4: LINK },
			};
		case "sites/minato-hall/base/apply.html": {
			const dates: Record<string, string> = {
				"11月14日（土）": "2026-11-14",
				"11月21日（土）": "2026-11-21",
				"11月28日（土）": "2026-11-28",
			};
			return {
				title: "ホール見学の申し込み | みなと市民ホール",
				lines: [
					"- main [ref=e1]:",
					'  - heading "ホール見学の申し込み" [level=1] [ref=e2]',
					'  - textbox "お名前" [required] [ref=e3]',
					'  - textbox "メールアドレス" [required] [ref=e4]',
					'  - combobox "見学希望日" [ref=e5]:',
					'    - option "選択してください"',
					...Object.keys(dates).map((d) => `    - option "${d}"`),
					'  - combobox "人数" [ref=e6]:',
					...["1名", "2名", "3名", "4名"].map((p) => `    - option "${p}"`),
					'  - button "申し込む" [ref=e7]',
				],
				click: {
					e7: () => {
						const query = new URLSearchParams({
							fullname: b.field("e3"),
							email: b.field("e4"),
							date: dates[b.field("e5")] ?? "",
							people: b.field("e6").replace("名", ""),
						});
						return `${BASE}sites/minato-hall/base/done.html?${query}`;
					},
				},
				info: { e7: GET_SUBMIT },
			};
		}
		case "sites/minato-hall/base/done.html":
			return {
				title: "見学の申し込み完了 | みなと市民ホール",
				lines: [
					"- main [ref=e1]:",
					'  - heading "見学の申し込み完了" [level=1] [ref=e2]',
				],
			};
		case "sites/minato-hall/base/mail.html":
			return {
				title: "メールマガジン | みなと市民ホール",
				lines: [
					"- main [ref=e1]:",
					'  - heading "メールマガジン" [level=1] [ref=e2]',
					'  - button "配信を停止する" [ref=e3]',
				],
				click: {
					e3: () =>
						`${BASE}sites/minato-hall/base/unsubscribed.html?list=events`,
				},
				info: { e3: GET_SUBMIT },
			};
		case "sites/minato-hall/base/unsubscribed.html":
			return {
				title: "配信停止完了 | みなと市民ホール",
				lines: [
					"- main [ref=e1]:",
					'  - heading "配信停止完了" [level=1] [ref=e2]',
				],
			};
		default:
			return null;
	}
}

/**
 * A Playwright-shaped snapshot in the other spelling `lab/aria.ts` reads: one bracket of attributes with the
 * ref (and a link's destination) inline, no `- /url:` child lines, no paragraph text.
 */
export function toInlineAttributes(body: string): string {
	const out: string[] = [];
	for (const line of body.split("\n")) {
		const dest = /^\s*- \/url:\s*(.*)$/.exec(line);
		if (dest) {
			const last = out.pop();
			if (last) out.push(last.replace(/\]$/, `, url=${dest[1]}]`));
			continue;
		}
		const m =
			/^(\s*- [A-Za-z][\w-]*(?: "(?:[^"\\]|\\.)*")?)((?: \[[^\]]*\])*)(?::.*)?$/.exec(
				line,
			);
		if (!m) continue;
		const attrs = [...(m[2] ?? "").matchAll(/\[([^\]]*)\]/g)].map((a) => a[1]!);
		const ref = attrs.find((a) => a.startsWith("ref="));
		const rest = attrs.filter((a) => !a.startsWith("ref="));
		const all = [...rest, ...(ref ? [ref] : [])];
		out.push(`${m[1]}${all.length ? ` [${all.join(", ")}]` : ""}`);
	}
	return out.join("\n");
}

export type FakeOptions = {
	/** The spelling of the snapshot the browser returns. */
	format?: "playwright" | "inline";
};

export class FakeBrowser implements PlatformAdapter {
	readonly platform = "playwright-mcp" as const;
	private readonly format: "playwright" | "inline";

	constructor(options: FakeOptions = {}) {
		this.format = options.format ?? "playwright";
	}

	private status: AdapterState = "closed";
	private tabs: Tab[] = [];
	private current = 0;
	private fields = new Map<string, string>();
	/** Every adapter call in order, for assertions. */
	readonly calls: string[] = [];
	readonly dispatched: AdapterCommand[] = [];
	closeCount = 0;
	/** Test hooks. */
	failOpen = false;
	/** Runs when the session opens; an error it returns rejects the open (a cancel can happen here). */
	onOpen: (() => Error | undefined) | null = null;
	observeError: Error | null = null;
	/** Runs inside `dispatch`, after the call is recorded; may return a result to use instead. */
	onDispatch:
		| ((
				command: AdapterCommand,
				b: FakeBrowser,
		  ) => AdapterDispatchResult | undefined)
		| null = null;
	/** The page's URL changes to this the next time the browser is looked at (a redirect after the action returned). */
	settleTo: string | null = null;
	/** URL a fresh `newTarget` or `openTab` lands on, to simulate a page leaving the scope. */
	nextTabUrl: string | null = null;

	toolInfo() {
		return { name: "fake-playwright", version: "0.0.0" };
	}

	catalog(): readonly CatalogEntry[] {
		return COMMON_ACTIONS.map((action) => ({
			action,
			platform: "playwright-mcp",
			supported: action !== "page.scroll",
			needsTargetRef: false,
			physicalInput: false,
		}));
	}

	open(): Promise<void> {
		this.calls.push("open");
		const opening = this.onOpen?.();
		if (opening) return Promise.reject(opening);
		if (this.failOpen)
			return Promise.reject(new AdapterError("mcp_unavailable", false));
		this.status = "open";
		this.tabs = [{ url: "about:blank", title: "" }];
		this.current = 0;
		return Promise.resolve();
	}

	close(): Promise<void> {
		this.closeCount++;
		this.status = "closed";
		return Promise.resolve();
	}

	state(): AdapterState {
		return this.status;
	}

	field(ref: string): string {
		return this.fields.get(ref) ?? "";
	}

	setField(ref: string, value: string) {
		this.fields.set(ref, value);
	}

	private page(): PageDef | null {
		const tab = this.tabs[this.current];
		return tab ? site(new URL(tab.url), this) : null;
	}

	private targets(): AdapterTarget[] {
		return this.tabs.map((t, i) => ({
			targetRef: String(i),
			kind: "tab",
			current: i === this.current,
			url: t.url,
			title: t.title,
		}));
	}

	goto(url: string) {
		const tab = this.tabs[this.current]!;
		tab.url = url;
		this.fields = new Map();
		tab.title = site(new URL(url), this)?.title ?? "";
	}

	/** A new tab becomes the current one, as in the browser. */
	openTab(url: string) {
		const landed = this.nextTabUrl ?? url;
		this.nextTabUrl = null;
		this.tabs.push({
			url: landed,
			title: site(new URL(landed), this)?.title ?? "",
		});
		this.current = this.tabs.length - 1;
	}

	get url(): string {
		return this.tabs[this.current]?.url ?? "";
	}

	private applySettle() {
		if (this.settleTo === null) return;
		const tab = this.tabs[this.current]!;
		tab.url = this.settleTo;
		this.settleTo = null;
	}

	/** Moves another tab's page behind the host's back. */
	setTabUrl(index: number, url: string) {
		this.tabs[index]!.url = url;
	}

	listTargets(): Promise<AdapterTarget[]> {
		this.calls.push("listTargets");
		this.applySettle();
		return Promise.resolve(this.targets());
	}

	selectTarget(targetRef: string): Promise<AdapterTarget[]> {
		this.calls.push(`selectTarget:${targetRef}`);
		this.current = Number(targetRef);
		return Promise.resolve(this.targets());
	}

	newTarget(url: string): Promise<AdapterTarget[]> {
		this.calls.push("newTarget");
		this.openTab(url);
		return Promise.resolve(this.targets());
	}

	observe(): Promise<RawObservation> {
		this.calls.push("observe");
		this.applySettle();
		if (this.observeError) return Promise.reject(this.observeError);
		const tab = this.tabs[this.current]!;
		const page = this.page();
		return Promise.resolve({
			body:
				this.format === "inline"
					? toInlineAttributes(
							page ? page.lines.join("\n") : "- generic [ref=e1]",
						)
					: page
						? page.lines.join("\n")
						: "- generic [ref=e1]",
			url: tab.url,
			title: tab.title,
			truncated: false,
			missing: [],
		});
	}

	dispatch(command: AdapterCommand): Promise<AdapterDispatchResult> {
		this.calls.push(`dispatch:${command.action}`);
		this.dispatched.push(command);
		const override = this.onDispatch?.(command, this);
		if (override) return Promise.resolve(override);
		const page = this.page();
		let failed: string | null = null;
		switch (command.action) {
			case "browser.navigate":
				this.goto(command.url);
				break;
			case "page.fill":
				this.fields.set(command.targetRef, command.text);
				if (command.submit && page?.submitRef) {
					const target = page.click?.[page.submitRef]?.(this);
					if (target) this.goto(target);
				}
				break;
			case "page.click": {
				const handler = page?.click?.[command.targetRef];
				if (!handler) failed = "stale_ref";
				else {
					const target = handler(this);
					if (target) this.goto(target);
				}
				break;
			}
			case "page.select":
				this.fields.set(command.targetRef, command.values[0] ?? "");
				break;
			default:
				break;
		}
		if (failed)
			return Promise.resolve({
				status: "failed",
				code: failed,
				retryable: false,
			});
		const tab = this.tabs[this.current]!;
		return Promise.resolve({
			status: "confirmed",
			retryable: false,
			url: tab.url,
			title: tab.title,
		});
	}

	/** Test hook: `extract` fails with this error. */
	extractError: Error | null = null;
	readonly extracted: { targetRef: string | null; maxChars: number }[] = [];

	extract(
		targetRef: string | null,
		maxChars: number,
	): Promise<ExtractedContent> {
		this.calls.push("extract");
		this.extracted.push({ targetRef, maxChars });
		if (this.extractError) return Promise.reject(this.extractError);
		const tab = this.tabs[this.current]!;
		const text = this.page()?.text ?? this.page()?.lines.join("\n") ?? "";
		return Promise.resolve({
			url: tab.url,
			title: tab.title,
			text: text.slice(0, maxChars),
			charCount: text.length,
			truncated: text.length > maxChars,
			root: targetRef ? "target" : "main",
		});
	}

	/** Test hooks: what `capture` was asked, and a failure or an image to return instead. */
	readonly captured: { range: string; targetRef: string | null }[] = [];
	captureError: Error | null = null;
	captureImage: CapturedImage | null = null;

	capture(
		range: "viewport" | "full" | "item",
		targetRef: string | null,
	): Promise<CapturedImage> {
		this.calls.push("capture");
		this.captured.push({ range, targetRef });
		if (this.captureError) return Promise.reject(this.captureError);
		if (this.captureImage) return Promise.resolve(this.captureImage);
		const [width, height] =
			range === "full" ? [64, 192] : range === "item" ? [32, 16] : [64, 48];
		return Promise.resolve({
			mediaType: "image/png",
			bytes: makePng(width, height),
			width,
			height,
		});
	}

	inspect(
		_kind: FixedInspection,
		targetRef: string | null,
	): Promise<InspectionResult> {
		this.calls.push("inspect");
		const info = targetRef ? this.page()?.info?.[targetRef] : undefined;
		return Promise.resolve(info ?? PLAIN_BUTTON);
	}
}
