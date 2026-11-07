import type { ItemRecord, PageItem, PageSummary } from "../../../index.ts";
import {
	activeTab,
	type Body,
	observeFresh,
	PartFail,
	resolve,
	tabOf,
	notePage,
	type ExecutorContext,
} from "./context.ts";
import { pageOpen } from "./page.ts";
import { continuation, observationDigest } from "./browse.ts";
import type { ObservationEnvelope } from "../../../index.ts";

export type HiddenSortOption = {
	text: string;
	visible?: boolean;
	href: string | null;
	params: [string, string][];
};
export type HiddenSort = {
	url: string;
	params: [string, string][];
	digest?: string;
};

/** Legacy helper: preserves the summary without deciding which control means sort. */
export function withSortControls(
	summary: PageSummary,
	_records: readonly ItemRecord[],
): PageSummary {
	return summary;
}

/** The options of `inspectSort`'s JSON text; anything malformed is dropped. */
export function sortOptionsOf(json: unknown): HiddenSortOption[] {
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
		if (typeof text !== "string" || text === "") return [];
		return [
			{
				text: text.slice(0, 200),
				...(typeof (o as Record<string, unknown>).visible === "boolean"
					? { visible: (o as { visible: boolean }).visible }
					: {}),
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

/** Explicit neutral DOM inspection, in the same caller-owned inference loop. */
export async function inspectChoices(
	ctx: ExecutorContext,
	observation: ObservationEnvelope,
	within?: string | null,
	cursor?: string | null,
): Promise<Body> {
	if (!ctx.executor.choices) throw new PartFail("unsupported");
	const paging = continuation(
		ctx,
		observation,
		["choices", within ?? null],
		cursor,
	);
	const target = within ? resolve(ctx, within, observation).ref : null;
	const result = await ctx.executor.choices(
		await activeTab(ctx),
		observation.observationRef,
		target,
		paging.offset,
		20,
	);
	const options = sortOptionsOf(result.options);
	const total =
		typeof result.count === "number" && Number.isSafeInteger(result.count)
			? result.count
			: paging.offset + options.length;
	const items: PageItem[] = options.map((option) => {
		const url = option.href ? sortUrl(option, observation.url ?? "") : null;
		if (ctx.nextChoiceId > 99999) throw new PartFail("candidate_limit");
		const item = `${ctx.registry.pageIdFor(tabOf(observation), observation.url)}.i${ctx.nextChoiceId++}`;
		if (url)
			ctx.hiddenSorts.set(item, {
				url,
				params: option.params,
				digest: observationDigest(observation),
			});
		return {
			item,
			role: url ? "option" : "region",
			name: option.text,
			visible: option.visible,
			...(url ? { url } : {}),
			context: url
				? "Observed link; verify its purpose before choosing."
				: "No executable destination observed; use the visible control to reveal this choice.",
		};
	});
	notePage(
		ctx,
		undefined,
		observation.url,
		items.flatMap((i) => (i.url ? [i.url] : [])),
	);
	return {
		status: "completed",
		candidates: items,
		browse: paging.finish(total, paging.offset + options.length),
	};
}

/** Execute an observed link; the model decides what the landed page means. */
export async function openHiddenSort(
	ctx: ExecutorContext,
	sort: HiddenSort,
): Promise<Body> {
	if (ctx.blocked) throw new PartFail("site_blocked");
	if (sort.digest && observationDigest(await observeFresh(ctx)) !== sort.digest)
		throw new PartFail("observation_changed");
	return pageOpen(ctx, sort.url);
}
