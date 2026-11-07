import { randomUUID } from "node:crypto";
import type { ItemRecord } from "../../../index.ts";
import { CAPTURE_HOLDS, held } from "../../../core/parts/items.ts";
import { captureTargetHash } from "../capture-hash.ts";
import { CaptureError } from "../capture.ts";
import { observationDigest, observedItems } from "./browse.ts";
import {
	activeTab,
	guard,
	observeFresh,
	PartFail,
	resolve,
	toItem,
	summarize,
	type Body,
	type ExecutorContext,
} from "./context.ts";

export type PreparedCapture = {
	token: string;
	digest: string;
	tab: string;
	range: "viewport" | "full" | "item";
	item: string | null;
	expires: number;
};

export async function pageCapture(
	ctx: ExecutorContext,
	range: "viewport" | "full" | "item",
	item: string | null,
	phase = "prepare",
	confirmation?: string | null,
	assessment?: string | null,
	offset = 0,
): Promise<Body> {
	if (range === "item" && item === null) throw new PartFail("item_required");
	if (range !== "item" && item !== null) throw new PartFail("invalid_args");
	const observation = await observeFresh(ctx);
	const tab = await activeTab(ctx);
	const digest = observationDigest(observation);
	if (phase === "save") {
		const prepared = ctx.preparedCapture;
		if (
			!prepared ||
			!confirmation ||
			prepared.token !== confirmation ||
			prepared.expires < Date.now() ||
			!assessment?.trim()
		)
			throw new PartFail("capture_confirmation_required");
		// One use, including a failed dispatch: no duplicate image from replaying a confirmation.
		ctx.preparedCapture = null;
		if (
			prepared.digest !== digest ||
			prepared.tab !== tab ||
			prepared.range !== range ||
			prepared.item !== item
		)
			throw new PartFail("capture_target_changed", {
				page: summarize(ctx, observation),
			});
		return saveCapture(ctx, range, item, prepared);
	}
	const contents = observedItems(ctx, observation, item);
	const target = item ? resolve(ctx, item, observation).record : null;
	const parent = target?.parent
		? observedItems(ctx, observation, null).records.find(
				(r) => r.item === target.parent,
			)
		: undefined;
	const candidates = [
		...(parent ? [parent] : []),
		...contents.records.slice(0, 20),
	];
	const text = contents.scopeText;
	const token = randomUUID();
	ctx.preparedCapture = {
		token,
		digest,
		tab,
		range,
		item,
		expires: Date.now() + 300_000,
	};
	return {
		status: "completed",
		code: "capture_prepared",
		candidates: candidates.map(toItem),
		preview: {
			confirmation: token,
			range,
			item,
			target: target ? `${target.role} ${target.name}`.trim() : range,
			text: text.slice(offset, offset + 8000),
			truncated:
				offset + 8000 < text.length ||
				observation.truncated ||
				observation.missing.length > 0,
			missing: observation.missing,
			...(offset + 8000 < text.length ? { nextOffset: offset + 8000 } : {}),
		},
	};
}

async function saveCapture(
	ctx: ExecutorContext,
	range: "viewport" | "full" | "item",
	itemId: string | null,
	prepared: PreparedCapture,
): Promise<Body> {
	let ref: string | null = null;
	let observationRef: string | undefined;
	let target: ItemRecord | undefined;
	let seen: ItemRecord | undefined;
	if (range === "item") {
		if (itemId === null) throw new PartFail("item_required");
		const observation = await observeFresh(ctx);
		const found = resolve(ctx, itemId, observation);
		ref = found.ref;
		target = found.record;
		observationRef = observation.observationRef;
		// What the captured block holds, read from the observation it was found in (not issuing page ids).
		seen = ctx.core
			.summarizePage(
				{
					body: observation.body,
					truncated: observation.truncated,
					missing: observation.missing,
				},
				{ pageId: "p0", maxItems: 1, maxHeadings: 0 },
			)
			.records.find((r) => r.ref === found.ref);
	}
	const tabRef = await activeTab(ctx);
	const image = await guard(ctx, () =>
		ctx.executor.capture(tabRef, observationRef, range, ref),
	);
	const after = await observeFresh(ctx);
	if (observationDigest(after) !== prepared.digest)
		throw new PartFail("capture_target_changed", {
			page: summarize(ctx, after),
		});
	let saved;
	try {
		saved = await ctx.captures.save(range, image);
	} catch (error) {
		throw new PartFail(
			error instanceof CaptureError ? error.code : "capture_write_failed",
		);
	}
	ctx.recorder.captureSaved({
		...saved,
		...(target
			? {
					target: {
						role: target.role,
						nameHash: captureTargetHash(target.name),
					},
					...(seen?.holds?.length
						? {
								holds: seen.holds.slice(0, CAPTURE_HOLDS).map((label) => {
									const at = label.indexOf(" ");
									return {
										role: at < 0 ? label : label.slice(0, at),
										nameHash: captureTargetHash(
											at < 0 ? "" : label.slice(at + 1),
										),
									};
								}),
								...(seen.holdsCount !== undefined &&
								seen.holdsCount > seen.holds.length
									? { holdsCount: seen.holdsCount }
									: {}),
							}
						: {}),
				}
			: {}),
	});
	ctx.deps.events.event("capture.saved", {});
	return {
		status: "completed",
		capture: {
			captureId: saved.captureId,
			width: saved.width,
			height: saved.height,
			fileName: saved.fileName,
			mediaType: saved.mediaType,
			...(target
				? {
						target: `${target.role} ${target.name}`.trim().slice(0, 80),
						...(seen?.block ? { block: seen.block } : {}),
						...(seen?.holds?.length ? held(seen, CAPTURE_HOLDS) : {}),
					}
				: {}),
		},
	};
}
