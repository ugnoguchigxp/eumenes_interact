import { createHash, randomUUID } from "node:crypto";
import type { ObservationEnvelope, ItemRecord } from "../../../index.ts";
import {
	collect,
	pageItem,
	type Collected,
} from "../../../core/parts/items.ts";
import { textOf } from "../../../core/parts/summary.ts";
import { PartFail, batch, resolve, type ExecutorContext } from "./context.ts";

/** Identity of the evidence, not its capture time or freshly issued envelope id. */
export function observationDigest(o: ObservationEnvelope): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				o.sessionId,
				o.target,
				o.generation,
				o.url,
				o.title,
				o.body,
				o.truncated,
				o.missing,
			]),
		)
		.digest("hex");
}

export type Continuation = { key: string; offset: number; expires: number };
export function continuation(
	ctx: ExecutorContext,
	o: ObservationEnvelope,
	query: unknown,
	cursor: string | null | undefined,
) {
	const key = createHash("sha256")
		.update(observationDigest(o))
		.update(JSON.stringify(query))
		.digest("hex");
	let offset = 0;
	if (cursor) {
		const known = ctx.continuations.get(cursor);
		if (!known || known.key !== key || known.expires < Date.now())
			throw new PartFail("observation_changed");
		offset = known.offset;
	}
	return {
		offset,
		finish(total: number, end: number) {
			let next: string | null = null;
			if (end < total) {
				next = randomUUID();
				ctx.continuations.set(next, {
					key,
					offset: end,
					expires: Date.now() + 300_000,
				});
				while (ctx.continuations.size > 64)
					ctx.continuations.delete(ctx.continuations.keys().next().value!);
			}
			return {
				cursor: next,
				total,
				truncated: end < total || o.truncated || o.missing.length > 0,
			};
		},
	};
}

/** Scoped enumeration; every observed candidate remains reachable, in document order. */
export function observedItems(
	ctx: ExecutorContext,
	o: ObservationEnvelope,
	within: string | null | undefined,
) {
	const ref = within ? resolve(ctx, within, o).ref : null;
	return batch(ctx, o, (pageId) => {
		const c = collect(o.body, pageId);
		const nodesByRef = new Map<string, Collected["nodes"][number]>();
		for (const node of c.nodes) {
			if (node.ref !== null && !nodesByRef.has(node.ref))
				nodesByRef.set(node.ref, node);
		}
		const root = ref === null ? undefined : nodesByRef.get(ref);
		const made = ctx.core.summarizePage(
			{ body: o.body, truncated: o.truncated, missing: o.missing },
			{ pageId, maxItems: 100_000, maxHeadings: 0 },
		);
		const records = made.records.filter((r) => {
			const node = nodesByRef.get(r.ref);
			return (
				!root || (!!node && node.index >= root.index && node.index < root.end)
			);
		});
		return {
			...c,
			nodesByRef,
			records,
			scopeText: (root ? c.nodes.slice(root.index, root.end) : c.nodes)
				.map((n) => n.name || n.text)
				.filter(Boolean)
				.join("\n"),
		};
	});
}

export function contextualItem(
	c: Collected & {
		nodesByRef: ReadonlyMap<string, Collected["nodes"][number]>;
	},
	r: ItemRecord,
) {
	const node = c.nodesByRef.get(r.ref);
	const context = node ? textOf(c.nodes, node).slice(0, 320) : "";
	return { ...pageItem(r), ...(context ? { context } : {}) };
}
