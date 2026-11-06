import type { ItemRecord, ObservationEnvelope } from "../../../index.ts";
import { toUri } from "../uri.ts";
import { querySourced as sourced } from "../../source.ts";
import { generalSearchUrl } from "../search-urls.ts";
import { isPagingEntry } from "./paging.ts";
import {
	afterSending,
	batch,
	elementName,
	observationAfter,
	observeFresh,
	operate,
	passChallenge,
	PartFail,
	summarize,
	SUMMARY_HEADINGS,
	type Body,
	type ExecutorContext,
	type Target,
} from "./context.ts";

const SEARCH_LIST_LIMIT = 10;
const RESULTS_SETTLE_S = 3;

/** The path of a URL, or null for one that does not parse (a stored or observed URL is never trusted to). */
const pathOf = (url: string | undefined): string | null => {
	if (url === undefined) return null;
	try {
		return new URL(url).pathname;
	} catch {
		return null;
	}
};

/**
 * Every word of the query must have a source: a passage of the request (the same rule as a typed value), or
 * a passage of a verified result of an earlier step of the same request (a handoff, e.g. the ticker found in
 * step 1 searched in step 2). A word with neither — a guess — is refused.
 */
export function querySourced(ctx: ExecutorContext, query: string): boolean {
	return sourced(query, [ctx.deps.request, ...(ctx.deps.sources?.() ?? [])]);
}

/**
 * The search field: the site knowledge's `search.query`, else the page's search boxes, comboboxes and text
 * boxes named for search. With several, the one in a search region comes first, then one named for search,
 * then the first in document order: never an arbitrary pick, and never a field of a login or other form.
 */
export function searchField(
	ctx: ExecutorContext,
	observation: ObservationEnvelope,
): Target | null {
	if (observation.url !== undefined) {
		const found = ctx.deps.knowledge.resolve(
			observation.url,
			observation.body,
			"search.query",
		);
		if (found)
			return {
				ref: found.ref,
				record: {
					item: "p0.i0",
					role: found.role,
					name: found.name,
					ref: found.ref,
					nth: 0,
					count: 1,
				},
			};
	}
	const { records } = batch(ctx, observation, (pageId) => ({
		records: (["searchbox", "combobox", "textbox"] as const).flatMap((role) =>
			ctx.core.findItems(observation.body, pageId, { text: null, role }, 10),
		),
	}));
	const fields = records.filter(
		(r) =>
			r.role === "searchbox" ||
			ctx.searchName.test(r.name) ||
			r.region === "search" ||
			(r.role === "combobox" && r.name === ""),
	);
	const rank = (r: ItemRecord) =>
		r.region === "search"
			? 0
			: r.role === "searchbox"
				? 1
				: ctx.searchName.test(r.name)
					? 2
					: 3;
	const best = [...fields].sort((x, y) => rank(x) - rank(y))[0];
	return best ? { record: best, ref: best.ref } : null;
}

/** A button that only shows the search box (a magnifier in the header). */
export function revealButton(
	ctx: ExecutorContext,
	observation: ObservationEnvelope,
): Target | null {
	const { records } = batch(ctx, observation, (pageId) => ({
		records: ctx.core.findItems(
			observation.body,
			pageId,
			{ text: null, role: "button" },
			40,
		),
	}));
	const button = records.find((r) => ctx.searchName.test(r.name));
	return button ? { record: button, ref: button.ref } : null;
}

/** Types the query into the field and submits; null when the field did not take it. */
export async function typeSearch(
	ctx: ExecutorContext,
	field: Target,
	observation: ObservationEnvelope,
	query: string,
): Promise<ObservationEnvelope | null> {
	const s = await operate(
		ctx,
		{
			action: "page.fill",
			targetRef: field.ref,
			element: elementName(field.record),
			text: query,
			submit: true,
		},
		"input",
		{ observation, valueChecked: true, recoverable: true },
	);
	if (s.kind !== "operation") return null;
	if (s.result.status !== "confirmed") return null;
	return afterSending(ctx, () => observationAfter(ctx, s));
}

export async function openUrl(
	ctx: ExecutorContext,
	url: string,
): Promise<ObservationEnvelope | null> {
	const s = await operate(
		ctx,
		{ action: "browser.navigate", url: toUri(url) },
		"navigation",
	);
	if (s.kind !== "operation" || s.result.status !== "confirmed") return null;
	return afterSending(ctx, () => observationAfter(ctx, s));
}

/** Same title and same headings: the same page content, whatever its address says. */
export function samePage(
	ctx: ExecutorContext,
	a: ObservationEnvelope,
	b: ObservationEnvelope,
): boolean {
	if (a.title !== b.title) return false;
	// Read without issuing page ids: this comparison must not register a page.
	const headings = (o: ObservationEnvelope) =>
		ctx.core.summarizePage(
			{ body: o.body, truncated: o.truncated, missing: o.missing },
			{ pageId: "p0", maxItems: 1, maxHeadings: SUMMARY_HEADINGS },
		).summary.headings;
	const ha = headings(a);
	const hb = headings(b);
	return ha.length > 0 && ha.join("\n") === hb.join("\n");
}

export async function siteSearch(
	ctx: ExecutorContext,
	query: string,
): Promise<Body> {
	if (!querySourced(ctx, query)) throw new PartFail("query_not_in_request");
	const start = await passChallenge(ctx, await observeFresh(ctx));
	const origin = start.url ?? "";
	const tried: string[] = [];
	let after: ObservationEnvelope | null = null;
	// 1. The page's own search box. 2. The site's own search page the host knows. 3. A general engine, only
	// where the policy allows it. 4. A button that shows a hidden box: last, because a button click asks the
	// user's approval (no site is exempt), and a URL that needs none is preferred.
	let field = searchField(ctx, start);
	let page = start;
	let landedDirect = false;
	if (field) {
		tried.push("box");
		after = await typeSearch(ctx, field, page, query);
		// The box took the text but the page did not move (a script-only box, a language it ignores): no search
		// happened, so the next way is tried rather than the unchanged page being reported as results.
		// A box whose page moves only after its script has run (NDL Search: a second or more) gets one short
		// wait before that is decided.
		// A page whose address has moved while it still shows the start page's content (a client-side route
		// that renders a moment later) is waited for the same way, so the start page's links are never
		// reported as results.
		const unchanged = (o: ObservationEnvelope) =>
			o.url === start.url || samePage(ctx, o, start);
		if (after && unchanged(after)) {
			await operate(
				ctx,
				{ action: "page.wait", seconds: RESULTS_SETTLE_S },
				"none",
			);
			after = await observeFresh(ctx);
			if (unchanged(after)) after = null;
		}
	}
	if (!after) {
		const known = ctx.deps.knowledge.searchUrl?.(origin, query) ?? null;
		if (known) {
			tried.push("site_url");
			after = await openUrl(ctx, known);
			// The site went straight to the one thing searched for (a quote, an article): that is a result.
			const landed = pathOf(after?.url);
			if (landed !== null && landed !== pathOf(known)) landedDirect = true;
		}
	}
	if (!after) {
		const general = generalSearchUrl(origin, query);
		if (general) {
			tried.push("general");
			// A general engine outside the run's allowed origins is refused by the policy: then nothing is opened.
			after = await openUrl(ctx, general);
		}
	}
	if (!after) {
		const button = revealButton(ctx, start);
		if (button) {
			tried.push("reveal");
			const clicked = await operate(
				ctx,
				{
					action: "page.click",
					targetRef: button.ref,
					element: elementName(button.record),
				},
				"navigation",
				{ observation: start },
			);
			if (
				clicked.kind === "operation" &&
				clicked.result.status === "confirmed"
			) {
				page = await observationAfter(ctx, clicked);
				field = searchField(ctx, page);
				if (field) after = await typeSearch(ctx, field, page, query);
			}
		}
	}
	if (!after) {
		throw new PartFail("no_search_box", { page: summarize(ctx, page) });
	}
	after = await passChallenge(ctx, after);
	const collect = (after: ObservationEnvelope) => {
		const listed = batch(ctx, after, (pageId) =>
			ctx.core.listEntries(after.body, pageId, "results", SEARCH_LIST_LIMIT),
		);
		// "Skip to main content" links are on every page, results or not: they never count as a result.
		// Script-only links (javascript:, "#") are page widgets (tabs, toggles), not results.
		const isResult = (e: { title: string; url?: string }) =>
			!/^skip (to|navigation)\b/i.test(e.title.trim()) &&
			!/^(javascript:|#)/i.test((e.url ?? "").replace(/^"|"$/g, "").trim());
		let kept = listed.entries.filter(isResult);
		// When the list the page shape suggests has no real result, the links that name the query are the
		// results (a site that lays them out as a plain run of links or a table).
		if (!kept.some((e) => !isPagingEntry(ctx, e, after.url))) {
			const named = batch(ctx, after, (pageId) => ({
				records: ctx.core.findItems(
					after.body,
					pageId,
					{ text: query, role: "link" },
					SEARCH_LIST_LIMIT,
				),
			}));
			const byName = named.records
				.map((r) => ({
					item: r.item,
					title: r.name,
					...(r.url ? { url: r.url } : {}),
				}))
				.filter(isResult);
			if (byName.length) kept = [...byName, ...kept];
		}
		// Page numbers and next/prev links are listed where the page puts them, often above the results: they
		// go after the real results, and alone they are not results.
		const paging = kept.filter((e) => isPagingEntry(ctx, e, after.url));
		const real = kept.filter((e) => !isPagingEntry(ctx, e, after.url));
		const results = real.length ? [...real, ...paging] : [];
		return { results, truncated: listed.truncated };
	};
	let { results, truncated } = collect(after);
	// Sites that render results client-side show them a moment after the page loads: look once more.
	if (results.length === 0 && !landedDirect) {
		await operate(
			ctx,
			{ action: "page.wait", seconds: RESULTS_SETTLE_S },
			"none",
		);
		after = await observeFresh(ctx);
		({ results, truncated } = collect(after));
	}
	const summary = summarize(ctx, after);
	if (results.length === 0) {
		if (landedDirect) return { status: "completed", page: summary };
		throw new PartFail("zero_results", { status: "partial", page: summary });
	}
	return {
		status: "completed",
		page: summary,
		list: {
			kind: "results",
			entries: results,
			truncated,
		},
	};
}
