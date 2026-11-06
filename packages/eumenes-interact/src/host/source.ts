import { spaced, squash } from "../core/shared/text.ts";
import { Refusal } from "./errors.ts";

/**
 * Where a typed value, a chosen option or a search word comes from (plan.md §9). One rule set, used by the part
 * executor before it acts and by the host again before it sends, because the model's call is not trusted and
 * nothing a page showed can supply a quote. Code checks only how strings relate (containment, word edges,
 * coverage). What the words mean is the model's to say through the quote it picks; a choice these rules cannot
 * tie to the request is asked of the user (needs_input), never matched through a word list.
 */

// `squash` (compare typed values) and `spaced` (see word edges) are the core's, so both checks agree.

export const QUOTE_MIN = 2;
const QUOTE_VALUE_FACTOR = 4;
const QUOTE_VALUE_SLACK = 32;
/**
 * The share of a longer label a quote must cover. 「11月21日」 covers 6 of 「11月21日(土)」's 9 characters and
 * chooses it; "terms" (5 of 35) does not tick "I agree to the terms and conditions".
 */
export const CHOICE_QUOTE_COVERAGE = 0.5;
const IMPLIED_LABEL_MAX = 200;

/**
 * A letter or digit of a script written with spaces between words (Latin, Cyrillic, Greek, Hangul, Arabic …):
 * only there can a match run on into a longer word. Scripts without spaces (Han, kana, Thai …) have no edge.
 */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const NO_SPACES =
	/[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]/u;
const isWordChar = (c: string) =>
	c !== "" && LETTER_OR_DIGIT.test(c) && !NO_SPACES.test(c);

/**
 * Whether `needle` occurs in `hay` without a word character running on past either edge ("yes" is not in
 * "yesterday", "Да" not in "Дальше"). Scripts without spaces between words (Japanese) have no such edge.
 */
export function containsAtWordEdge(hay: string, needle: string): boolean {
	if (needle === "") return false;
	const first = isWordChar(needle[0]!);
	const last = isWordChar(needle.at(-1)!);
	for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
		const before = hay[i - 1] ?? "";
		const after = hay[i + needle.length] ?? "";
		if ((!first || !isWordChar(before)) && (!last || !isWordChar(after)))
			return true;
	}
	return false;
}

/**
 * A typed value is the request's own words: `quote` is a passage of the request, and the value is inside it.
 * Separators may differ (「090-1234-5678」 for 「09012345678」); a value much longer than its passage may not.
 */
export function assertValueQuoted(
	value: string,
	quote: string,
	request: string,
): void {
	const q = squash(quote);
	const v = squash(value);
	if (
		q.length < QUOTE_MIN ||
		v === "" ||
		!q.includes(v) ||
		value.length > QUOTE_VALUE_FACTOR * q.length + QUOTE_VALUE_SLACK ||
		!squash(request).includes(q)
	)
		throw new Refusal("grant_source_mismatch");
}

/**
 * The 0.1.x name of `assertValueQuoted`. Since 0.2.0 it also requires the passage to hold the value: before,
 * any value within the length bound passed beside any two-character passage of the request.
 */
export const assertQuoted = assertValueQuoted;

/**
 * A choice (an option chosen, a box turned on) is the request's: `quote` is a passage of the request at word
 * edges, and either the label holds the quote and the quote covers at least half of it, or the quote holds the
 * whole label. Whether the user wants it on or off stays the model's to say.
 */
export function assertChoiceQuoted(
	label: string,
	quote: string,
	request: string,
): void {
	const q = spaced(quote);
	const l = spaced(label);
	const tied =
		squash(quote).length >= QUOTE_MIN &&
		l !== "" &&
		containsAtWordEdge(spaced(request), q) &&
		((containsAtWordEdge(l, q) &&
			q.length >= CHOICE_QUOTE_COVERAGE * l.length) ||
			containsAtWordEdge(q, l));
	if (!tied) throw new Refusal("grant_source_mismatch");
}

/**
 * The passage that ties a label to the request when the model quoted none: the longest run the two share at word
 * edges, if it covers enough of the label (「ギフト包装」 of 「ギフト包装にする」 for 「ギフト包装あり」). Before 0.2.0
 * any four characters in a row were enough, so "tion" of "information" ticked "I agree to the … conditions".
 */
export function impliedQuote(label: string, request: string): string | null {
	const l = spaced(label);
	// The search is quadratic in the label; a label this long names no choice (the parts cut names at 120).
	if (l.length > IMPLIED_LABEL_MAX) return null;
	const r = spaced(request);
	const shortest = Math.max(
		QUOTE_MIN,
		Math.ceil(CHOICE_QUOTE_COVERAGE * l.length),
	);
	for (let length = l.length; length >= shortest; length--)
		for (let i = 0; i + length <= l.length; i++) {
			const run = l.slice(i, i + length);
			if (run.startsWith(" ") || run.endsWith(" ")) continue;
			if (containsAtWordEdge(l, run) && containsAtWordEdge(r, run)) return run;
		}
	return null;
}

/**
 * Whether the request makes a choice. A quote the model gave must hold by itself (a quote that fails is not
 * replaced by a guess); without one, the model's value is tried as the request's words for it, then the passage
 * the label and the request share.
 */
export function choiceSourced(
	label: string,
	request: string,
	from: { quote?: string | null; value?: string },
): boolean {
	const tied = (quote: string) => {
		try {
			assertChoiceQuoted(label, quote, request);
			return true;
		} catch {
			return false;
		}
	};
	if (from.quote != null) return tied(from.quote);
	if (from.value !== undefined && tied(from.value)) return true;
	const implied = impliedQuote(label, request);
	return implied !== null && tied(implied);
}

/**
 * Every word of a search query has a source: a passage of one of `texts` (the request, or a verified result of an
 * earlier step of the same request). A one-character word must stand as a word there.
 */
export function querySourced(query: string, texts: readonly string[]): boolean {
	const words = query.split(/[\s　]+/).filter(Boolean);
	if (words.length === 0) return false;
	return words.every((word) =>
		texts.some((text) => {
			if (squash(word).length < QUOTE_MIN)
				return containsAtWordEdge(spaced(text), spaced(word));
			try {
				assertValueQuoted(word, word, text);
				return true;
			} catch {
				return false;
			}
		}),
	);
}
