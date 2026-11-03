import type { ItemRecord, PageItem } from "../../contracts/parts.ts";
import { clip } from "../arm0/text.ts";
import {
	isItemNode,
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

export function collect(body: string, pageId: string): Collected {
	const nodes = parseNodes(body);
	const itemNodes = nodes.filter(isItemNode);
	const seen = new Map<string, number>();
	const records = itemNodes.map((node, i): ItemRecord => {
		const region = regionOf(nodes, node);
		const base = {
			item: `${pageId}.i${i + 1}`,
			role: node.role,
			name: clip(node.name, NAME_CHARS),
			...(region ? { region } : {}),
			...(node.role === "link" && node.url
				? { url: clip(node.url, URL_CHARS) }
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
});
