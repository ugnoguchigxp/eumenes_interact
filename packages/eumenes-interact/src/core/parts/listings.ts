import type { ItemRecord, ListEntry } from "../../contracts/parts.ts";
import { clip, parseUrl } from "../shared/text.ts";
import { collect, type Collected } from "./items.ts";
import { ancestors, descendants, type Node } from "./snapshot.ts";
import { textOf } from "./summary.ts";

const TEXT_CHARS = 200;

export function listEntries(
	body: string,
	pageId: string,
	kind: "results" | "table" | "links",
	limit: number,
): { entries: ListEntry[]; records: ItemRecord[]; truncated: boolean } {
	const c = collect(body, pageId);
	// A link whose accessible name is empty (MDN's search results, 2026-11-04) is named by the text inside
	// it, else by the last segment of its URL; a link with none of these is not an entry.
	const links = c.itemNodes
		.map((node, i) => ({ node, record: c.records[i]! }))
		.filter(({ node }) => node.role === "link")
		.map(({ node, record }) => ({
			node,
			record,
			title: node.name || textOf(c.nodes, node) || urlLabel(record.url),
		}))
		.filter(({ title }) => title);
	let entries: { entry: ListEntry; record?: ItemRecord }[];
	if (kind === "table") entries = tableRows(c);
	else {
		const chosen = links;
		entries = chosen.map(({ node, record, title }) => ({
			entry: {
				item: record.item,
				title,
				...(record.url ? { url: record.url } : {}),
				...(record.region ? { region: record.region } : {}),
				...(kind === "results" ? textFor(c.nodes, node, title) : {}),
			},
			record,
		}));
	}
	return {
		entries: entries.slice(0, limit).map((e) => e.entry),
		records: entries
			.slice(0, limit)
			.flatMap((e) => (e.record ? [e.record] : [])),
		truncated: entries.length > limit,
	};
}

/** The readable last path segment of a link's URL ("/docs/Web/.../flat" -> "flat"); "" when none. */
function urlLabel(url: string | undefined): string {
	if (!url) return "";
	try {
		const u = parseUrl(url.replace(/^"|"$/g, ""), "https://x.invalid/");
		if (u.protocol !== "http:" && u.protocol !== "https:") return "";
		const last = u.pathname.split("/").filter(Boolean).at(-1) ?? "";
		return decodeURIComponent(last).slice(0, 80);
	} catch {
		return "";
	}
}

/** The short text beside a result's link: text nodes of its list item or article. */
function textFor(nodes: readonly Node[], link: Node, title: string) {
	const container = ancestors(nodes, link).find(
		(a) => a.role === "listitem" || a.role === "article",
	);
	if (!container) return {};
	const text = cleanEntryText(
		descendants(nodes, container)
			.filter(
				(n) => n.role === "text" || n.role === "paragraph" || n.role === "code",
			)
			.map((n) => n.text || n.name)
			.filter((t) => t && t !== title)
			.join(" "),
	);
	return text ? { text: clip(text, TEXT_CHARS) } : {};
}

/** Drop a11y-tree quote crumbs Open Library leaves in card text (`","`, `\",\"`) (2026-11-05). */
function cleanEntryText(raw: string): string {
	return raw
		.replace(/(?:\\*["']\s*,\s*\\*["'])+/g, " ")
		.replace(/(?:\\+["'])+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

function tableRows(c: Collected) {
	const table = c.nodes.find((n) => n.role === "table");
	if (!table) return [];
	const rows = descendants(c.nodes, table).filter((n) => n.role === "row");
	return rows.flatMap((row) => {
		const cells = descendants(c.nodes, row)
			.filter((n) =>
				["cell", "gridcell", "columnheader", "rowheader"].includes(n.role),
			)
			.map((cell) => textOf(c.nodes, cell))
			.filter(Boolean);
		if (!cells.length) return [];
		const at = c.itemNodes.findIndex(
			(n) => n.role === "link" && n.index > row.index && n.index < row.end,
		);
		const record = at < 0 ? undefined : c.records[at];
		return [
			{
				entry: {
					title: clip(cells.join(" | "), TEXT_CHARS),
					...(record
						? {
								item: record.item,
								...(record.url ? { url: record.url } : {}),
							}
						: {}),
				} satisfies ListEntry,
				...(record ? { record } : {}),
			},
		];
	});
}
