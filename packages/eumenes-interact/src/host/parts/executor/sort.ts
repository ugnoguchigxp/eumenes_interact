import type { ItemRecord, PageItem, PageSummary } from "../../../index.ts";
import {
	compilePattern,
	DEFAULT_LEXICON,
} from "../../../core/shared/lexicon.ts";
import {
	activeTab,
	toItem,
	type Body,
	type ExecutorContext,
} from "./context.ts";
import { pageOpen } from "./page.ts";

export type HiddenSortOption = {
	text: string;
	href: string | null;
	params: [string, string][];
};
export type HiddenSort = { url: string; params: [string, string][] };

/** Names of the controls that order a list, by default (the executor uses its deps' lexicon). */
const SORT_NAME = compilePattern(DEFAULT_LEXICON.sortChoice);
const SORT_ROLES = new Set([
	"link",
	"button",
	"option",
	"combobox",
	"tab",
	"radio",
	"menuitem",
	"menuitemradio",
]);

/**
 * A list's sort controls are put at the head of the page's items when the summary's cap left them out:
 * "安い順" on a long results page is otherwise reached only by guessing a page.find term.
 */
export function withSortControls(
	summary: PageSummary,
	records: readonly ItemRecord[],
	sortName: RegExp = SORT_NAME,
): PageSummary {
	const shown = new Set(summary.items.map((i) => i.item));
	const sorts = records
		.filter(
			(r) =>
				SORT_ROLES.has(r.role) &&
				r.name.length <= 40 &&
				sortName.test(r.name) &&
				!shown.has(r.item),
		)
		.slice(0, 6);
	if (sorts.length === 0) return summary;
	return { ...summary, items: [...sorts.map(toItem), ...summary.items] };
}

/** The options of `inspectSort`'s JSON text; anything malformed is dropped. */
export function sortOptionsOf(
	json: unknown,
	sortName: RegExp = SORT_NAME,
): HiddenSortOption[] {
	if (typeof json !== "string") return [];
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	return value.flatMap((o): HiddenSortOption[] => {
		if (typeof o !== "object" || o === null) return [];
		const { text, href, params } = o as Record<string, unknown>;
		if (typeof text !== "string" || text === "" || !sortName.test(text))
			return [];
		return [
			{
				text: text.slice(0, 40),
				href: typeof href === "string" ? href : null,
				params: Array.isArray(params)
					? params.filter(
							(p): p is [string, string] =>
								Array.isArray(p) &&
								typeof p[0] === "string" &&
								typeof p[1] === "string",
						)
					: [],
			},
		];
	});
}

const decoded = (s: string) => {
	try {
		return decodeURIComponent(s.replaceAll("+", " "));
	} catch {
		return s;
	}
};

/**
 * Where a sort choice leads: its own link, else the current URL with its parameters set. A parameter whose
 * value the URL already carries (the search word, in the path or the query) is left as it is; a choice that
 * would change nothing has no URL.
 */
export function sortUrl(
	option: Pick<HiddenSortOption, "href" | "params">,
	current: string,
): string | null {
	let base: URL;
	try {
		base = new URL(option.href ?? current, current);
	} catch {
		return null;
	}
	if (base.protocol !== "http:" && base.protocol !== "https:") return null;
	if (option.href !== null) return base.href;
	const carried = decoded(base.pathname + base.search);
	let changed = false;
	for (const [key, value] of option.params) {
		const v = decoded(value);
		if (base.searchParams.get(key) === v || carried.includes(v)) continue;
		base.searchParams.set(key, v);
		changed = true;
	}
	return changed ? base.href : null;
}

/** The landed URL carries each parameter the choice set (or is the choice's own link). */
export function sortApplied(landed: string, sort: HiddenSort): boolean {
	let at: URL;
	let want: URL;
	try {
		at = new URL(landed);
		want = new URL(sort.url);
	} catch {
		return false;
	}
	for (const [key, value] of want.searchParams)
		if (at.searchParams.get(key) !== value) return false;
	return true;
}

/**
 * The landed page's own links carry the choice's parameters (a site that sorts by script and leaves the
 * address bar as it was still writes the order into its category and paging links): the order took.
 */
export function sortCarried(
	items: readonly PageItem[],
	sort: HiddenSort,
): boolean {
	let want: URL;
	try {
		want = new URL(sort.url);
	} catch {
		return false;
	}
	const pairs = [...want.searchParams].filter(([k]) =>
		sort.params.some(([key]) => key === k),
	);
	if (pairs.length === 0) return false;
	return items.some((i) => {
		if (!i.url || i.role === "option") return false;
		try {
			const u = new URL(i.url, sort.url);
			return pairs.every(([k, v]) => u.searchParams.get(k) === v);
		} catch {
			return false;
		}
	});
}

/**
 * A list whose order control the accessibility tree leaves out (a custom dropdown: "並べ替え：" over a hidden
 * `<li onclick>`) gets its choices as items, found by the adapter's fixed read-only `inspectSort`. Each
 * leads to the page's URL with the choice's own parameters; opening one is a navigation (URL policy) and
 * is checked to have landed with them.
 */
export async function withHiddenSorts(
	ctx: ExecutorContext,
	body: Body,
): Promise<Body> {
	const page = body.page;
	if (
		!page ||
		!ctx.executor.sortOptions ||
		!ctx.lastSeen ||
		!page.url ||
		!ctx.sortLabel.test(ctx.lastSeen.body) ||
		page.items.some((i) => ctx.sortName.test(i.name))
	)
		return body;
	let options: HiddenSortOption[];
	try {
		const r = await ctx.executor.sortOptions(await activeTab(ctx));
		options = sortOptionsOf(r.options, ctx.sortName);
	} catch {
		return body;
	}
	const items: PageItem[] = [];
	for (const option of options) {
		const url = sortUrl(option, page.url);
		if (url === null) continue;
		// The item id form the parts' contract accepts, from the top of its range: a page's own items never get there.
		const item = `${page.page}.i${99991 + items.length}`;
		ctx.hiddenSorts.set(item, { url, params: option.params });
		items.push({ item, role: "option", name: option.text, url });
	}
	if (items.length === 0) return body;
	return { ...body, page: { ...page, items: [...items, ...page.items] } };
}

/** Opens a hidden sort choice by its URL and reports whether the page landed sorted that way. */
export async function openHiddenSort(
	ctx: ExecutorContext,
	sort: HiddenSort,
): Promise<Body> {
	const opened = await pageOpen(ctx, sort.url, { hostDerived: true });
	const landed = opened.page?.url ?? "";
	return sortApplied(landed, sort) ||
		sortCarried(opened.page?.items ?? [], sort)
		? opened
		: { ...opened, status: "partial", code: "sort_not_applied" };
}
