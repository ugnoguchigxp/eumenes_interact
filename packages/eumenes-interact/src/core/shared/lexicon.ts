/**
 * The words the parts look for on pages (design R12, the first step of F09): which links page a list, which
 * fields search, which controls and labels sort, which labels mark an ad, which pages are a bot check. They are
 * data in one place, versioned and hashed with the distribution, so a new word is a visible data change with its
 * reason recorded (an external spec, a reproduced failure or a measurement), never a branch in the code.
 *
 * This moves the words; it does not reduce them. Choosing from the observation and the request instead (F09's
 * main step) is measured separately. A host may give the part executor its own (`PartExecutorDeps.lexicon`); the
 * core's summary, the in-page sort inspection and the bot-check test use the default.
 */

/** A regular expression as data: what `new RegExp(source, flags)` takes. */
export type LexiconPattern = {
	readonly source: string;
	readonly flags: string;
};

export type Lexicon = {
	readonly version: number;
	/** A result-list entry that only pages ("2", "次へ", "next ›"). */
	readonly paging: LexiconPattern;
	/** The name of a search field or its button. */
	readonly searchField: LexiconPattern;
	/** The name of a control that orders a list ("安い順", "Price: low to high"). */
	readonly sortChoice: LexiconPattern;
	/** Text saying the list has an order control ("並べ替え", "Sort by"). */
	readonly sortLabel: LexiconPattern;
	/** The same two, as the in-page inspection reads an element's own text. */
	readonly inspectSortChoice: LexiconPattern;
	readonly inspectSortLabel: LexiconPattern;
	/** The label of an ad or sponsored entry ("PR", "広告"). */
	readonly adLabel: LexiconPattern;
	/** A bot check shown instead of the page. */
	readonly botCheck: LexiconPattern;
};

const of = (r: RegExp): LexiconPattern => ({
	source: r.source,
	flags: r.flags,
});

/** The 0.1.x words, unchanged (test/core/lexicon.test.ts holds the same set). */
export const DEFAULT_LEXICON: Lexicon = Object.freeze({
	version: 1,
	paging: of(
		/^(?:\d{1,3}|[<>«»‹›]+|next|prev(?:ious)?|次(?:へ|のページ)?|前(?:へ|のページ)?|最初|最後|もっと見る)[\s>»›]*$/i,
	),
	searchField: of(/search|検索|keyword|キーワード|query|探す|探し|find/i),
	sortChoice: of(
		/(安い順|高い順|価格の?(安|低|高)い|低価格|価格順|新しい順|新着順|人気順|評価順|並び替え|並べ替え|ソート|\bsort\b|sort by|price:? *low|lowest price|price.*(asc|desc))/iu,
	),
	sortLabel: of(/並べ替え|並び替え|並び順|表示順|ソート|sort by|sort:/i),
	inspectSortChoice: of(
		/(安い順|高い順|価格の?(安|低|高)い|低価格|高価格|価格順|新しい順|古い順|新着順|人気順|評価順|レビュー順|おすすめ順|売れ筋|price.{0,16}(low|high|asc|desc)|lowest|highest|newest|best.?sell|top.?rated)/i,
	),
	inspectSortLabel: of(/(並べ替え|並び替え|並び順|表示順|ソート|sort)/i),
	adLabel: of(
		/^(\[?(PR|AD|広告|スポンサー|Sponsored|Ad|Ads|プロモーション)\]?)($|[\s・:：\]])/i,
	),
	botCheck: of(
		/just a moment|verify(?:ing)? (?:that )?you are (?:a )?human|human verification|performing security verification|review the security of your connection|enable javascript and cookies to continue|checking your browser|attention required|are you a robot|unusual traffic|captcha|ロボットではありません|しばらくお待ちください.{0,20}確認/i,
	),
});

/** A pattern made usable; an invalid one fails here, when the lexicon is given, not when a page is read. */
export const compilePattern = (p: LexiconPattern) =>
	new RegExp(p.source, p.flags);
