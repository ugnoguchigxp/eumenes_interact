import type { ListEntry } from "../../../contracts/parts.ts";
import type { ExecutorContext } from "./context.ts";

/**
 * Which list entries only page the list (design R25, one step of F09). Decided first by structure, which needs
 * no word and so holds in any language; the lexicon's paging words are only the fallback for an entry whose
 * structure says nothing (no address, or an address that is not like the page's).
 *
 * Structure: a link to the same page address that differs from it only in one query parameter whose value is a
 * small integer (`?q=x&page=3`, `?start=20`), or whose path ends `/page/N` over the same path and query; or a
 * title that is only digits or arrows. A paging label is short, so a long title is never taken for one by its
 * address alone.
 */

const SMALL_INT = /^\d{1,3}$/;
const ARROWS = /^[<>«»‹›←→↑↓…\s]+$/u;
const DIGITS = /^\p{Nd}{1,3}$/u;
/** A paging link's title is a label or a number, not a sentence. */
const LABEL_CHARS = 30;
const PAGE_SEGMENT = /^(.*)\/page\/\d{1,4}\/?$/;

function parse(raw: string | undefined, base?: string): URL | null {
	if (raw === undefined) return null;
	try {
		const u = new URL(raw.trim().replace(/^"|"$/g, ""), base);
		return u.protocol === "http:" || u.protocol === "https:" ? u : null;
	} catch {
		return null;
	}
}

const trimSlash = (path: string) =>
	path.length > 1 ? path.replace(/\/+$/, "") : path;

/** Whether `link` is `page` with one numeric query parameter changed. */
function oneNumericParam(link: URL, page: URL): boolean {
	if (link.origin !== page.origin) return false;
	if (trimSlash(link.pathname) !== trimSlash(page.pathname)) return false;
	const keys = new Set([
		...link.searchParams.keys(),
		...page.searchParams.keys(),
	]);
	const differing = [...keys].filter(
		(k) =>
			link.searchParams.getAll(k).join("\0") !==
			page.searchParams.getAll(k).join("\0"),
	);
	if (differing.length !== 1) return false;
	const key = differing[0]!;
	const values = [link.searchParams.get(key), page.searchParams.get(key)];
	return values.every((v) => v === null || SMALL_INT.test(v));
}

/** Whether `link` is `page` with a trailing `/page/N` (or a different N) and the same query. */
function pageSegment(link: URL, page: URL): boolean {
	if (link.origin !== page.origin) return false;
	const linkPath = PAGE_SEGMENT.exec(trimSlash(link.pathname));
	if (!linkPath) return false;
	const pagePath = trimSlash(page.pathname);
	const base = PAGE_SEGMENT.exec(pagePath)?.[1] ?? pagePath;
	return (
		trimSlash(linkPath[1] || "/") === trimSlash(base || "/") &&
		link.search === page.search
	);
}

/** The structure alone: true when the entry pages the list. */
export function pagesByStructure(
	entry: Pick<ListEntry, "title" | "url">,
	pageUrl: string | undefined,
): boolean {
	const title = entry.title.trim();
	if (DIGITS.test(title) || (title !== "" && ARROWS.test(title))) return true;
	if ([...title].length > LABEL_CHARS) return false;
	const page = parse(pageUrl);
	const link = page ? parse(entry.url, page.href) : null;
	if (!page || !link) return false;
	return oneNumericParam(link, page) || pageSegment(link, page);
}

/** Structure first; the lexicon's words only when the structure does not decide. */
export function isPagingEntry(
	ctx: Pick<ExecutorContext, "paging">,
	entry: Pick<ListEntry, "title" | "url">,
	pageUrl: string | undefined,
): boolean {
	return (
		pagesByStructure(entry, pageUrl) || ctx.paging.test(entry.title.trim())
	);
}
