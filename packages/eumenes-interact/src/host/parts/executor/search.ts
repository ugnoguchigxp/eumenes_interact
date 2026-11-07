import { querySourced as sourced } from "../../source.ts";
import { generalSearchUrl } from "../search-urls.ts";
import { observedItems, contextualItem } from "./browse.ts";
import {
	afterSending,
	elementName,
	observationAfter,
	observeFresh,
	operate,
	PartFail,
	resolve,
	summarize,
	type ExecutorContext,
	type Body,
} from "./context.ts";

export function querySourced(ctx: ExecutorContext, query: string): boolean {
	return sourced(query, [ctx.deps.request, ...(ctx.deps.sources?.() ?? [])]);
}

/** The model supplies the field. Without it this is a read-only discovery, never an implicit choice. */
export async function siteSearch(
	ctx: ExecutorContext,
	query: string,
	fieldId?: string | null,
): Promise<Body> {
	if (!querySourced(ctx, query)) throw new PartFail("query_not_in_request");
	const observation = await observeFresh(ctx);
	if (!fieldId) {
		const all = observedItems(ctx, observation, null);
		const known = observation.url
			? ctx.deps.knowledge.resolve(
					observation.url,
					observation.body,
					"search.query",
				)
			: null;
		const fields = all.records.filter((r) =>
			["searchbox", "textbox", "combobox"].includes(r.role),
		);
		const urls = [
			observation.url
				? ctx.deps.knowledge.searchUrl?.(observation.url, query)
				: null,
			observation.url ? generalSearchUrl(observation.url, query) : null,
		].filter((s): s is string => typeof s === "string");
		return {
			status: "completed",
			code: "target_required",
			page: summarize(ctx, observation),
			candidates: fields.slice(0, 20).map((r) => ({
				...contextualItem(observation, r),
				...(known?.ref === r.ref ? { storedCandidate: true } : {}),
			})),
			...(urls.length ? { searchUrls: urls } : {}),
		};
	}
	if (ctx.blocked) throw new PartFail("site_blocked");
	const field = resolve(ctx, fieldId, observation);
	if (!["searchbox", "textbox", "combobox"].includes(field.record.role))
		throw new PartFail("target_not_editable");
	const sent = await operate(
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
	if (sent.kind !== "operation" || sent.result.status !== "confirmed")
		throw new PartFail("search_not_confirmed");
	const after = await afterSending(ctx, () => observationAfter(ctx, sent));
	// Execution confirmed. Whether the page contains results is the model's next judgment.
	return { status: "completed", page: summarize(ctx, after) };
}
