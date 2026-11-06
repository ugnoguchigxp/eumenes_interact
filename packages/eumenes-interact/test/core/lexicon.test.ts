import { describe, expect, test } from "bun:test";
import {
	compilePattern,
	DEFAULT_LEXICON,
	type LexiconPattern,
} from "../../src/core/shared/lexicon.ts";

/**
 * The default lexicon is the 0.1.x word set, moved out of the code unchanged (design R12). A word added or
 * removed changes this table too, with the reason in the change (an external spec, a reproduced failure or a
 * measurement).
 */
const V01: Record<Exclude<keyof typeof DEFAULT_LEXICON, "version">, RegExp> = {
	paging:
		/^(?:\d{1,3}|[<>«»‹›]+|next|prev(?:ious)?|次(?:へ|のページ)?|前(?:へ|のページ)?|最初|最後|もっと見る)[\s>»›]*$/i,
	searchField: /search|検索|keyword|キーワード|query|探す|探し|find/i,
	sortChoice:
		/(安い順|高い順|価格の?(安|低|高)い|低価格|価格順|新しい順|新着順|人気順|評価順|並び替え|並べ替え|ソート|\bsort\b|sort by|price:? *low|lowest price|price.*(asc|desc))/iu,
	sortLabel: /並べ替え|並び替え|並び順|表示順|ソート|sort by|sort:/i,
	inspectSortChoice:
		/(安い順|高い順|価格の?(安|低|高)い|低価格|高価格|価格順|新しい順|古い順|新着順|人気順|評価順|レビュー順|おすすめ順|売れ筋|price.{0,16}(low|high|asc|desc)|lowest|highest|newest|best.?sell|top.?rated)/i,
	inspectSortLabel: /(並べ替え|並び替え|並び順|表示順|ソート|sort)/i,
	adLabel:
		/^(\[?(PR|AD|広告|スポンサー|Sponsored|Ad|Ads|プロモーション)\]?)($|[\s・:：\]])/i,
	botCheck:
		/just a moment|verify(?:ing)? (?:that )?you are (?:a )?human|human verification|performing security verification|review the security of your connection|enable javascript and cookies to continue|checking your browser|attention required|are you a robot|unusual traffic|captcha|ロボットではありません|しばらくお待ちください.{0,20}確認/i,
};

describe("lexicon (R12)", () => {
	test("version 1 holds exactly the 0.1.x patterns", () => {
		expect(DEFAULT_LEXICON.version).toBe(1);
		const { version: _version, ...patterns } = DEFAULT_LEXICON;
		expect(Object.keys(patterns).sort()).toEqual(Object.keys(V01).sort());
		for (const [name, old] of Object.entries(V01)) {
			const p = patterns[name as keyof typeof patterns] as LexiconPattern;
			expect({ name, source: p.source, flags: p.flags }).toEqual({
				name,
				source: old.source,
				flags: old.flags,
			});
		}
	});

	test("a pattern is compiled once from its data", () => {
		const paging = compilePattern(DEFAULT_LEXICON.paging);
		expect(paging.test("次へ")).toBe(true);
		expect(paging.test("商品一覧")).toBe(false);
		expect(() => compilePattern({ source: "(", flags: "" })).toThrow();
	});

	test("the default cannot be changed in place", () => {
		expect(Object.isFrozen(DEFAULT_LEXICON)).toBe(true);
	});
});
