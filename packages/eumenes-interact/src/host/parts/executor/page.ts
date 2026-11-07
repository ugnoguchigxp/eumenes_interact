import { findText } from "../../../index.ts";
import { fromPage, urlPayload } from "../../../core/shared/text.ts";
import { toUri } from "../uri.ts";
import {
	activeTab,
	afterSending,
	batch,
	confirmed,
	notePage,
	urlKey,
	guard,
	observationAfter,
	observeFresh,
	operate,
	passChallenge,
	PartFail,
	resolve,
	summarize,
	toItem,
	type Body,
	type ExecutorContext,
} from "./context.ts";

import { continuation, contextualItem, observedItems } from "./browse.ts";
import { inspectChoices } from "./sort.ts";

const FIND_LIMIT = 20;

/**
 * What opening this URL declares (design R21). Navigation, as before, for an address the run saw (a page's own
 * or a link on a page) or that the request or an earlier verified result states. For any other address, whose
 * path, query or fragment carries a run of page text this run read (the page-run rule of `fromPage`: at least
 * eight characters a page showed and the request and earlier results did not contain), opening it could hand
 * that text to a site: it is declared `submit`, so the host asks the user first. Structure only: no word is
 * looked for, and the address's host is not read.
 */
export function openEffect(
	ctx: ExecutorContext,
	url: string,
): "navigation" | "submit" {
	const payload = urlPayload(url);
	if (payload === null) return "navigation";
	const key = urlKey(url);
	if (key !== null && ctx.seenUrls.has(key)) return "navigation";
	const own = [ctx.deps.request, ...(ctx.deps.sources?.() ?? [])];
	if (own.some((text) => text.includes(url))) return "navigation";
	return fromPage(payload, own.join("\0"), ctx.seenText)
		? "submit"
		: "navigation";
}

export async function pageOpen(
	ctx: ExecutorContext,
	url: string,
	options: { hostDerived?: boolean } = {},
): Promise<Body> {
	const s = confirmed(
		ctx,
		await operate(
			ctx,
			{ action: "browser.navigate", url: toUri(url) },
			options.hostDerived ? "navigation" : openEffect(ctx, url),
		),
	);
	const landed = await passChallenge(
		ctx,
		await afterSending(ctx, () => observationAfter(ctx, s)),
	);
	return { status: "completed", page: summarize(ctx, landed) };
}

export async function pageBack(ctx: ExecutorContext): Promise<Body> {
	const s = confirmed(
		ctx,
		await operate(ctx, { action: "browser.back" }, "navigation"),
	);
	return {
		status: "completed",
		page: summarize(
			ctx,
			await passChallenge(
				ctx,
				await afterSending(ctx, () => observationAfter(ctx, s)),
			),
		),
	};
}

export async function pageFind(
	ctx: ExecutorContext,
	text: string | null,
	role: string | null,
	within?: string | null,
	cursor?: string | null,
	inspect = false,
): Promise<Body> {
	const observation = await observeFresh(ctx);

	if (inspect) return inspectChoices(ctx, observation, within, cursor);
	const paging = continuation(
		ctx,
		observation,
		["find", text, role, within ?? null],
		cursor,
	);
	const all = observedItems(ctx, observation, within);
	const fold = (v: string) => v.normalize("NFKC").toLowerCase();
	const matching = all.records.filter(
		(r) =>
			(!role || role === "any" || r.role === role) &&
			(!text || fold(r.name).includes(fold(text))),
	);
	if (matching.length || !text || within || cursor) {
		const shown = matching.slice(paging.offset, paging.offset + FIND_LIMIT);
		const hits = text
			? batch(ctx, observation, (pageId) =>
					findText(observation.body, pageId, text, FIND_LIMIT),
				).hits
			: [];
		const content = hits
			.map((h) => (h.item ? `[${h.item}] ${h.text}` : h.text))
			.join("\n");
		return {
			status: "completed",
			candidates: shown.map((r) => contextualItem(all, r)),
			browse: paging.finish(matching.length, paging.offset + shown.length),
			...(content
				? {
						read: {
							text: content,
							charCount: content.length,
							truncated: false,
						},
					}
				: {}),
		};
	}
	const { records } = batch(ctx, observation, (pageId) => ({
		records: ctx.core.findItems(
			observation.body,
			pageId,
			{ text, role },
			FIND_LIMIT,
		),
	}));
	// Named items come first; the body text that also says it rides along (a link named "Population" must
	// not hide the paragraph with the number).
	if (records.length > 0) {
		const extra =
			text === null
				? { hits: [] }
				: batch(ctx, observation, (pageId) =>
						findText(observation.body, pageId, text, FIND_LIMIT),
					);
		if (extra.hits.length === 0)
			return { status: "completed", candidates: records.map(toItem) };
		const body = extra.hits
			.map((h) => (h.item ? `[${h.item}] ${h.text}` : h.text))
			.join("\n");
		return {
			status: "completed",
			candidates: records.map(toItem),
			read: { text: body, charCount: body.length, truncated: false },
		};
	}
	// No item is named so: the text may be in the page's body (a paragraph, a cell). The hits come back as
	// read text, each with the item nearest to it.
	if (text !== null) {
		const found = batch(ctx, observation, (pageId) =>
			findText(observation.body, pageId, text, FIND_LIMIT),
		);
		if (found.hits.length) {
			const lines = found.hits.map((h) =>
				h.item ? `[${h.item}] ${h.text}` : h.text,
			);
			const body = lines.join("\n");
			return {
				status: "completed",
				candidates: [
					...new Map(found.records.map((r) => [r.item, r])).values(),
				].map(toItem),
				read: { text: body, charCount: body.length, truncated: false },
			};
		}
	}
	// The whole phrase is not on the page: each of its words may be (a guessed phrase like "初登頂の年" or
	// "Population 2025" rarely appears verbatim). Hits for any word come back, saying which words matched, so
	// the next call need not guess a new phrase.
	const words =
		text === null
			? []
			: [...new Set(text.split(/[\s、,，・/]+/u))].filter((w) => w.length >= 2);
	if (words.length >= 2) {
		const byWord = words.map((w) => ({
			w,
			found: batch(ctx, observation, (pageId) =>
				findText(observation.body, pageId, w, FIND_LIMIT),
			),
		}));
		const matched = byWord.filter((b) => b.found.hits.length > 0);
		if (matched.length) {
			const hits = matched.flatMap((b) => b.found.hits).slice(0, FIND_LIMIT);
			const body = [
				`[語ごとの一致: ${matched.map((b) => b.w).join(" / ")}（「${text}」そのものはなし）]`,
				...hits.map((h) => (h.item ? `[${h.item}] ${h.text}` : h.text)),
			].join("\n");
			return {
				status: "completed",
				candidates: [
					...new Map(
						matched.flatMap((b) => b.found.records).map((r) => [r.item, r]),
					).values(),
				]
					.slice(0, FIND_LIMIT)
					.map(toItem),
				read: { text: body, charCount: body.length, truncated: false },
			};
		}
	}
	throw new PartFail("target_not_found", { candidates: [] });
}

export async function pageWait(
	ctx: ExecutorContext,
	text: string | null,
	seconds: number | null,
): Promise<Body> {
	if (text === null && seconds === null) throw new PartFail("invalid_args");
	const s = confirmed(
		ctx,
		await operate(
			ctx,
			text !== null
				? { action: "page.wait", text }
				: { action: "page.wait", seconds: seconds! },
			"none",
		),
	);
	return {
		status: "completed",
		page: summarize(ctx, await observationAfter(ctx, s)),
	};
}

export async function pageRead(
	ctx: ExecutorContext,
	itemId: string | null,
	maxChars: number,
): Promise<Body> {
	let ref: string | null = null;
	let observationRef: string | undefined;
	let name = "";
	if (itemId !== null) {
		const observation = await observeFresh(ctx);
		const target = resolve(ctx, itemId, observation);
		ref = target.ref;
		name = target.record.name.trim();
		observationRef = observation.observationRef;
	}
	const tabRef = await activeTab(ctx);
	const content = await guard(ctx, () =>
		ctx.executor.extract(tabRef, observationRef, ref, maxChars),
	);
	notePage(ctx, content.text);
	// A page that turned into a bot check after it was opened (a late redirect, an adopted tab) is never
	// read as content: it is reported, not passed.
	// A link or cell read on its own says only its name ("Japan"); the value sits beside it (the row). The
	// page's text around each place the name stands alone is returned instead, so no second read is needed.
	if (name.length > 0 && content.text.trim() === name) {
		const whole = await guard(ctx, () =>
			ctx.executor.extract(tabRef, undefined, null, 50000),
		);
		notePage(ctx, whole.text);
		const around = surrounding(whole.text, name, maxChars);
		if (around !== null) {
			const text = `[「${name}」の周辺]\n${around}`;
			return {
				status: "completed",
				read: {
					text,
					charCount: text.length,
					truncated: false,
					...(whole.url === undefined ? {} : { url: whole.url }),
					...(whole.title === undefined ? {} : { title: whole.title }),
				},
			};
		}
	}
	const text = content.text.slice(0, maxChars);
	return {
		status: "completed",
		read: {
			text,
			charCount: content.charCount,
			truncated: content.truncated || text.length < content.text.length,
			...(content.url === undefined ? {} : { url: content.url }),
			...(content.title === undefined ? {} : { title: content.title }),
		},
	};
}

export async function pageList(
	ctx: ExecutorContext,
	kind: "results" | "table" | "links",
	limit: number,
	within?: string | null,
	cursor?: string | null,
): Promise<Body> {
	const observation = await observeFresh(ctx);
	const paging = continuation(
		ctx,
		observation,
		["list", kind, within ?? null, limit],
		cursor,
	);
	const scope = observedItems(ctx, observation, within);
	const allowed = new Set(scope.records.map((r) => r.item));
	const listed = batch(ctx, observation, (pageId) =>
		ctx.core.listEntries(observation.body, pageId, kind, 100_000),
	);
	const entries = listed.entries.filter(
		(e) => !within || (e.item !== undefined && allowed.has(e.item)),
	);
	const shown = entries.slice(paging.offset, paging.offset + limit);
	if (!shown.length && !cursor)
		throw new PartFail("no_entries", {
			list: { kind, entries: [], truncated: false },
		});
	const browse = paging.finish(entries.length, paging.offset + shown.length);
	return {
		status: "completed",
		list: { kind, entries: shown, truncated: browse.truncated },
		browse,
	};
}

/**
 * The text around each line of `text` that is `name` alone (else each place it occurs), up to three, each
 * from a little before it to a little after, within `maxChars`. Null when the name is not in the text.
 */
export function surrounding(
	text: string,
	name: string,
	maxChars: number,
): string | null {
	const lines = text.split("\n");
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		if (line.trim() === name) starts.push(offset + line.indexOf(name));
		offset += line.length + 1;
	}
	if (starts.length === 0) {
		for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1))
			starts.push(i);
	}
	if (starts.length === 0) return null;
	const per = Math.max(120, Math.floor(maxChars / Math.min(3, starts.length)));
	const before = Math.floor(per / 4);
	return starts
		.slice(0, 3)
		.map((i) => {
			const from = Math.max(0, i - before);
			const to = Math.min(text.length, from + per);
			return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\n{2,}/g, "\n")}${to < text.length ? "…" : ""}`;
		})
		.join("\n---\n");
}
