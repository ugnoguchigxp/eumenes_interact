// URL is a global of every runtime the core runs in; lib ES2022 does not declare it.
declare const URL: new (
	input: string,
	base?: string,
) => {
	origin: string;
	hostname: string;
	pathname: string;
	protocol: string;
	search: string;
	hash: string;
	username: string;
	password: string;
};

/** Pure WHATWG parsing; the supported Node/Bun runtimes supply the global, with no DOM or IO port. */
export const parseUrl = (input: string, base?: string) => new URL(input, base);

const URL_CHARS = 160;

export const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}…` : text;

/** Query and fragment can carry secrets; the model sees where a tab is, not what it was sent. */
export function placeOf(raw: string) {
	try {
		const url = new URL(raw);
		return clip(`${url.origin}${url.pathname}`, URL_CHARS);
	} catch {
		return "";
	}
}

/** The origin of an http(s) page, or null. */
export function originOf(raw: string | null | undefined) {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.origin
			: null;
	} catch {
		return null;
	}
}

/** Separators people add or drop without changing what was written (spaces, dashes, commas, slashes). */
const SEPARATORS = /[\s\-‐–—,，、/／]+/g;

/**
 * Width and case folded. The long vowel mark is a dash only between digits (「090ー1234」 typed through an IME);
 * inside a word it is part of the word, so 「ビール」 does not become 「ビル」.
 */
const folded = (text: string) =>
	text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/(?<=\d)ー(?=\d)/g, "-");

/** Width, case, spacing and the separators people add to numbers do not change what was written. */
export const squash = (text: string) => folded(text).replace(SEPARATORS, "");

/** Width and case folded, separators kept as one space: the form in which word edges can be seen. */
export const spaced = (text: string) =>
	folded(text).replace(SEPARATORS, " ").trim();

/** A run this long, shared with a page and not with the request, is not the user's own value. */
const PAGE_RUN = 8;
const SEEN_ENTRIES = 6;
const SEEN_CHARS = 200_000;

/** Page-derived text a task has read (normalised); older entries go first when it grows past its bounds. */
export function addSeen(seen: readonly string[], ...texts: string[]) {
	const next = [...seen];
	for (const text of texts) {
		const squashed = squash(text);
		if (squashed) next.push(squashed);
	}
	while (
		next.length > SEEN_ENTRIES ||
		(next.length > 1 && next.reduce((n, s) => n + s.length, 0) > SEEN_CHARS)
	)
		next.shift();
	return next;
}

/**
 * Whether the value carries a run of at least eight normalised characters that a page showed and the user's
 * request did not contain. Such a value comes from the page, so the user must allow it before it is typed.
 */
export function fromPage(
	value: string,
	request: string,
	seen: readonly string[],
) {
	const v = squash(value);
	if (v.length < PAGE_RUN || !seen.length) return false;
	const asked = squash(request);
	// The value's runs the request does not have, then one pass over each page: linear in what was read, not
	// (value length × page length) as a search per run would be.
	const runs = new Set<string>();
	for (let i = 0; i + PAGE_RUN <= v.length; i++) {
		const run = v.slice(i, i + PAGE_RUN);
		if (!asked.includes(run)) runs.add(run);
	}
	if (runs.size === 0) return false;
	for (const page of seen)
		for (let i = 0; i + PAGE_RUN <= page.length; i++)
			if (runs.has(page.slice(i, i + PAGE_RUN))) return true;
	return false;
}

const decoded = (piece: string) => {
	try {
		return decodeURIComponent(piece.replace(/\+/g, " "));
	} catch {
		return piece;
	}
};

/**
 * What a URL carries besides where it goes: the path, the query (names and values), the fragment, the userinfo,
 * and the host's labels left of its last two (`8f3k29dj71.evil.com` sends `8f3k29dj71` through DNS), percent-decoded,
 * one piece per line. Null for text that is not an absolute URL.
 */
export function urlPayload(raw: string): string | null {
	try {
		const url = new URL(raw);
		const labels = /^[\d.]+$|^\[/.test(url.hostname)
			? []
			: url.hostname.split(".").slice(0, -2);
		const userinfo = [url.username, url.password];
		const query = url.search
			.replace(/^\?/, "")
			.split("&")
			.flatMap((pair) => pair.split("="));
		const hash = url.hash.replace(/^#/, "");
		return [labels, userinfo, url.pathname.split("/"), query, [hash]]
			.flat()
			.map(decoded)
			.filter((piece) => piece !== "")
			.join("\n");
	} catch {
		return null;
	}
}

const JST_OFFSET_MS = 9 * 3_600_000;

/**
 * Epoch milliseconds as local ISO 8601 in Japan Standard Time with its offset
 * (`2026-10-18T05:15:00.123+09:00`), so a date is never read in UTC.
 */
export function jstIso(ms: number): string {
	return new Date(ms + JST_OFFSET_MS).toISOString().replace("Z", "+09:00");
}

/** The current time as prompt data: local ISO 8601 with its offset, so the date is never read in UTC. */
export function promptTime(ms: number) {
	return {
		now: jstIso(ms),
		timeZone: "Asia/Tokyo",
	};
}

/** UTF-8 length of a string in bytes; a lone surrogate counts as U+FFFD, as TextEncoder encodes it. */
export function utf8Length(text: string) {
	let bytes = 0;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return bytes;
}
