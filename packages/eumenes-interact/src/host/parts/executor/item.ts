import type {
	InspectionResult,
	ItemRecord,
	ObservationEnvelope,
} from "../../../index.ts";
import {
	activeTab,
	afterSending,
	confirmed,
	elementName,
	observationAfter,
	observeFresh,
	operate,
	passChallenge,
	PartFail,
	resolve,
	step,
	summarize,
	type Body,
	type ExecutorContext,
	type Target,
} from "./context.ts";
import { pageOpen } from "./page.ts";
import { openHiddenSort } from "./sort.ts";

/**
 * What `item.open` may click, with the effect the part declares. In Arm 1 the part, not the model, declares the
 * effect: a link opens a page, and a button is a submission, as `form.submit` is, so it always asks first (the
 * ported gate alone lets a GET form's submit button through, which in Arm 0 the model declares as a submit).
 * Fields are for `form.fill` (its value rules), and content blocks are for reading and capturing.
 */
const OPENABLE: Readonly<Record<string, "navigation" | "submit">> = {
	link: "navigation",
	menuitem: "navigation",
	tab: "navigation",
	button: "submit",
};

/**
 * A link or menu item without a destination of its own (none, `#…` or `javascript:`) runs page script, which may
 * delete or buy, so it asks first as a button does (design R05). A tab only switches what the page shows.
 *
 * Playwright MCP gives no `/url` line to `<a role="menuitem" href>` (verified against the real snapshot, design
 * R18). The host's inspection of the element may therefore supply the destination: an `<a>` or `<area>` whose
 * `href` attribute it reports. Without a destination in either place the item still asks.
 */
export function effectOf(
	record: Pick<ItemRecord, "role" | "url">,
	inspection?: InspectionResult | null,
): "navigation" | "submit" | undefined {
	const effect = OPENABLE[record.role];
	if (effect !== "navigation" || record.role === "tab") return effect;
	const inspected =
		inspection &&
		(inspection.tag === "a" || inspection.tag === "area") &&
		typeof inspection.href === "string"
			? inspection.href
			: undefined;
	// Read as a browser does (WHATWG): tabs and newlines anywhere are dropped, and C0 controls and spaces at the
	// ends, so "java\nscript:" is still script.
	const url = (record.url || inspected || "")
		.replace(/[\t\n\r]/g, "")
		.replace(/^[\0-\x20]+|[\0-\x20]+$/g, "");
	return url === "" || url.startsWith("#") || /^javascript:/i.test(url)
		? "submit"
		: "navigation";
}

/**
 * Clicks an element. A click may open a page in a new tab: the tab list is compared before and after, the
 * new tab is selected and observed, and later parts work on it. Only Arm 1 does this; Arm 0 stays as Eumenes.
 */
export async function click(
	ctx: ExecutorContext,
	target: Target,
	observation: ObservationEnvelope,
	effect: "navigation" | "submit",
): Promise<ObservationEnvelope> {
	const before = new Set(ctx.tabs.open().map((t) => t.tabRef));
	const s = confirmed(
		ctx,
		await operate(
			ctx,
			{
				action: "page.click",
				targetRef: target.ref,
				element: elementName(target.record),
			},
			effect,
			{ observation },
		),
	);
	return afterSending(ctx, async () => {
		const opened = ctx.tabs.open().filter((t) => !before.has(t.tabRef));
		const fresh = opened.at(-1);
		if (fresh) {
			const selected = await step(ctx, {
				kind: "tabs.select",
				tabRef: fresh.tabRef,
			});
			if (selected.kind === "refused") throw new PartFail(selected.code);
			if (selected.kind !== "operation" || !selected.observation)
				throw new PartFail("observation_unavailable");
			ctx.active = fresh.tabRef;
			return selected.observation;
		}
		return observationAfter(ctx, s);
	});
}

/**
 * The host's inspection of a link or menu item the snapshot gave no destination: the only case in which the
 * effect depends on it. A host without the port, or an inspection that fails, leaves the item asking first.
 */
async function inspectedLink(
	ctx: ExecutorContext,
	target: Target,
	observation: ObservationEnvelope,
): Promise<InspectionResult | null> {
	const { role, url } = target.record;
	if (
		(role !== "link" && role !== "menuitem") ||
		url ||
		!ctx.executor.inspectTarget
	)
		return null;
	try {
		return await ctx.executor.inspectTarget(
			await activeTab(ctx),
			observation.observationRef,
			target.ref,
		);
	} catch {
		return null;
	}
}

export async function itemOpen(
	ctx: ExecutorContext,
	itemId: string,
): Promise<Body> {
	const sort = ctx.hiddenSorts.get(itemId);
	if (sort) return openHiddenSort(ctx, sort);
	const observation = await observeFresh(ctx);
	let target: Target;
	try {
		target = resolve(ctx, itemId, observation);
	} catch (error) {
		// A link the page re-rendered (MDN's search results: empty names, rebuilt after load) may no longer be
		// told apart from its neighbours, or found at all. The link the model chose had a URL: that URL is opened
		// instead, through the same navigation (and URL policy) as page.open. Other items still fail.
		const record = ctx.registry.lookup(itemId)?.record;
		if (
			error instanceof PartFail &&
			(error.code === "target_ambiguous" ||
				error.code === "target_not_found") &&
			record?.role === "link" &&
			record.name === "" &&
			record.url
		) {
			let href: string | null = null;
			try {
				href = new URL(record.url, observation.url).href;
			} catch {}
			if (href) return pageOpen(ctx, href, { hostDerived: true });
		}
		throw error;
	}
	const effect = effectOf(
		target.record,
		await inspectedLink(ctx, target, observation),
	);
	if (effect === undefined) throw new PartFail("item_not_openable");
	// A link may land on a bot check (Cloudflare's "Just a moment..."): waited out once, else site_blocked.
	const after = await passChallenge(
		ctx,
		await click(ctx, target, observation, effect),
	);
	return { status: "completed", page: summarize(ctx, after) };
}
