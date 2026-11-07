import type { ItemRecord, PageItem } from "../../contracts/parts.ts";
import { clip } from "../shared/text.ts";
import {
	BLOCK_ROLES,
	descendants,
	isItemNode,
	ITEM_ROLES,
	NAME_CHARS,
	URL_CHARS,
	ancestors,
	landmarkLabel,
	parseNodes,
	type Node,
} from "./snapshot.ts";

/**
 * The items of a snapshot: the elements the AI may act on, each with an id that depends only on the document
 * order, so the same body always yields the same ids.
 */

export type Collected = {
	nodes: Node[];
	/** The node of each item, in document order; `records[i]` belongs to `itemNodes[i]`. */
	itemNodes: Node[];
	records: ItemRecord[];
};

const keyOf = (r: {
	role: string;
	name: string;
	region?: string | undefined;
}) => JSON.stringify([r.role, r.name, r.region ?? null]);

/** The nearest landmark or heading above a node. */
function regionOf(nodes: readonly Node[], node: Node) {
	for (const above of ancestors(nodes, node)) {
		const landmark = landmarkLabel(above);
		if (landmark) return landmark;
		if (above.role === "heading" && above.name) return clip(above.name, 80);
	}
	return undefined;
}

/** At most this many held elements are kept per block (a summary shows the first `HOLDS_SHOWN`). */
const HOLDS_KEPT = 12;
const HOLDS_SHOWN = 6;
const HOLD_CHARS = 60;
const LABEL_CHARS = 80;

/** `role name` (just the role when the node has no name). */
const labelOf = (node: Node, chars: number) =>
	clip(node.name ? `${node.role} ${node.name}` : node.role, chars);

/**
 * The nearest content block (an item that is not a control: article, table, figure…) above a node, as a label;
 * undefined when none, or when it is the region the item already names.
 */
function blockOf(
	nodes: readonly Node[],
	node: Node,
	region: string | undefined,
) {
	for (const above of ancestors(nodes, node)) {
		if (!isItemNode(above) || !BLOCK_ROLES.includes(above.role)) continue;
		const label = labelOf(above, LABEL_CHARS);
		return label === region ? undefined : label;
	}
	return undefined;
}

/**
 * What a content block holds: the named headings and items below it, content (headings, images, nested blocks)
 * before controls, each in document order. A structural fact of the snapshot; no word is looked for.
 */
function holdsOf(nodes: readonly Node[], block: Node) {
	const held = descendants(nodes, block).filter(
		(n) => n.name && (n.role === "heading" || isItemNode(n)),
	);
	const control = (n: Node) => ITEM_ROLES.includes(n.role);
	const ordered = [...held.filter((n) => !control(n)), ...held.filter(control)];
	return {
		holds: ordered.slice(0, HOLDS_KEPT).map((n) => labelOf(n, HOLD_CHARS)),
		count: ordered.length,
	};
}

export function collect(body: string, pageId: string): Collected {
	const nodes = parseNodes(body);
	const itemNodes = nodes.filter(isItemNode);
	const seen = new Map<string, number>();
	const records = itemNodes.map((node, i): ItemRecord => {
		const region = regionOf(nodes, node);
		const block = blockOf(nodes, node, region);
		const held = BLOCK_ROLES.includes(node.role)
			? holdsOf(nodes, node)
			: undefined;
		const parent = ancestors(nodes, node).find(
			(n) => isItemNode(n) && BLOCK_ROLES.includes(n.role),
		);
		const base = {
			item: `${pageId}.i${i + 1}`,
			role: node.role,
			name: clip(node.name, NAME_CHARS),
			...(region ? { region } : {}),
			...(node.role === "link" && node.url
				? { url: clip(node.url, URL_CHARS) }
				: {}),
			...(block ? { block } : {}),
			...(parent
				? { parent: `${pageId}.i${itemNodes.indexOf(parent) + 1}` }
				: {}),
			...(held && held.count > 0
				? { holds: held.holds, holdsCount: held.count }
				: {}),
		};
		const key = keyOf(base);
		const nth = seen.get(key) ?? 0;
		seen.set(key, nth + 1);
		return { ...base, ref: node.ref!, nth, count: 0 };
	});
	for (const record of records) record.count = seen.get(keyOf(record))!;
	return { nodes, itemNodes, records };
}

/** What the AI sees of a record: no ref, no position. */
export const pageItem = (r: ItemRecord): PageItem => ({
	item: r.item,
	role: r.role,
	name: r.name,
	...(r.region ? { region: r.region } : {}),
	...(r.url ? { url: r.url } : {}),
	...(r.block ? { block: r.block } : {}),
	...(r.parent ? { parent: r.parent } : {}),
	...(r.context ? { context: r.context } : {}),
	...(r.holds?.length ? held(r, HOLDS_SHOWN) : {}),
});

/** The held elements a record shows within `shown` entries, with the total when more exist. */
export function held(
	r: Pick<ItemRecord, "holds" | "holdsCount">,
	shown: number,
) {
	const holds = (r.holds ?? []).slice(0, shown);
	const total = r.holdsCount ?? holds.length;
	return {
		holds,
		...(total > holds.length ? { holdsCount: total } : {}),
	};
}

/** How many held elements an element capture reports. */
export const CAPTURE_HOLDS = HOLDS_KEPT;
