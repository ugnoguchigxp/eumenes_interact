import type { ItemRecord, ListEntry } from "../../contracts/parts.ts";
import { clip, parseUrl } from "../shared/text.ts";
import { compilePattern, DEFAULT_LEXICON } from "../shared/lexicon.ts";
import { collect, type Collected } from "./items.ts";
import { ancestors, descendants, type Node } from "./snapshot.ts";
import { textOf } from "./summary.ts";

const TEXT_CHARS = 200;

const NOT_RESULTS = ["navigation", "banner", "contentinfo", "complementary"];

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
		const chosen = kind === "links" ? links : resultLinks(c, links);
		entries = chosen.map(({ node, record, title }) => ({
			entry: {
				item: record.item,
				title,
				...(record.url ? { url: record.url } : {}),
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

type LinkItem = { node: Node; record: ItemRecord; title: string };

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

/**
 * Result entries: named links inside list items or articles, outside navigation. A page whose snapshot has
 * no such structure (a compact tree) falls back to the named links of the main region.
 */
function resultLinks(c: Collected, links: LinkItem[]): LinkItem[] {
	const outside = (node: Node) =>
		!ancestors(c.nodes, node).some((a) => NOT_RESULTS.includes(a.role));
	const hasMain = c.nodes.some((n) => n.role === "main");
	const inMain = (node: Node) =>
		!hasMain || ancestors(c.nodes, node).some((a) => a.role === "main");
	const candidates = links.filter(({ node }) => outside(node) && inMain(node));
	const structured = candidates.filter(({ node }) =>
		ancestors(c.nodes, node).some(
			(a) => a.role === "listitem" || a.role === "article",
		),
	);
	// Real results are not always list items (Kakaku.com's product cards, 2026-11-05), and list items are often
	// the site's own links (footer, categories): every candidate is ranked, list items keep a small preference.
	const listed = new Set(structured.map((l) => l.node.index));
	return candidates
		.map((l, i) => ({
			l,
			i,
			rank:
				resultRank(c.nodes, l.node, l.title, l.record.url) * 2 +
				(listed.has(l.node.index) ? 0 : 1),
		}))
		.sort((a, b) => a.rank - b.rank || a.i - b.i)
		.map(({ l }) => l);
}

const AD_TEXT = compilePattern(DEFAULT_LEXICON.adLabel);
const AD_URL =
	/doubleclick\.net|googleadservices|googlesyndication|criteo\.com|\/click\?ad=|adchoices|amazon-adsystem|\/aclk\?/i;
const CHROME_ROLES = [
	"tablist",
	"tab",
	"menu",
	"menubar",
	"menuitem",
	"toolbar",
];
/** "ゲーム機本体 (561)": a filter that narrows the list, not a result. */
const FACET = /[（(][\d,]+[)）]$/;
/** YouTube duration/thumbnail rows and channel jumps mixed into results (2026-11-05). */
const SITE_CHROME =
	/(^Go to channel\b|\bNow playing$|^\d{1,2}:\d{2}(\s|$)|^\d+:\d{2}:\d{2}\b)/i;

/** A bare site root (`https://kakaku.com` / `/`) is a logo, not a result. */
function siteRoot(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const u = parseUrl(url.replace(/^"|"$/g, ""), "https://x.invalid/");
		if (u.protocol !== "http:" && u.protocol !== "https:") return false;
		return (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash;
	} catch {
		return false;
	}
}

/** `/@name`, `/channel/…`, `/c/…`: a YouTube channel link beside a video card. */
function channelUrl(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const path = parseUrl(
			url.replace(/^"|"$/g, ""),
			"https://x.invalid/",
		).pathname;
		return /^\/@[^/]+\/?$/.test(path) || /^\/(channel|c|user)\//.test(path);
	} catch {
		return false;
	}
}

/** Footer-style notices next to a link ("※ ご購入の前に…"), even when not under contentinfo. */
function noticeBeside(
	nodes: readonly Node[],
	link: Node,
	inside: readonly Node[],
): boolean {
	const near = inside.length
		? inside
		: nodes.filter(
				(n) =>
					n.parent === link.parent &&
					(n.role === "text" || n.role === "paragraph"),
			);
	return near.some((n) => {
		if (n.index === link.index) return false;
		// Snapshot text often keeps the surrounding ASCII quotes from the YAML-like dump.
		const t = (n.name || n.text || "")
			.trim()
			.replace(/^["']|["']$/g, "")
			.trim();
		return t.startsWith("※") || /^\*\s/.test(t);
	});
}

/**
 * A link among four or more siblings that are only links (or list items holding only a link): a row of related
 * searches or categories ("人気の関連ワード", kakaku.com 2026-11-05), however long each title.
 */
function inLinkCloud(nodes: readonly Node[], link: Node): boolean {
	const item = nodes[link.parent];
	const holder = item?.role === "listitem" ? nodes[item.parent] : item;
	if (!holder) return false;
	const kids = nodes.filter((n) => n.parent === holder.index);
	if (kids.length < 4) return false;
	const onlyLink = (n: Node): boolean => {
		if (n.role === "link") return true;
		if (n.role !== "listitem") return false;
		const inner = nodes.filter((m) => m.parent === n.index);
		return inner.length === 1 && inner[0]!.role === "link";
	};
	return kids.every(onlyLink);
}

/**
 * How far down a result link goes (stable within a rank): 0 a result (a heading, an image or a long title, or
 * text beside it in its card), 1 a bare link, 2 a filter, tab or menu, 3 an ad. Kakaku.com, Open Library and
 * YouTube put their category, sort and tab links among the results (2026-11-04).
 */
function resultRank(
	nodes: readonly Node[],
	link: Node,
	title: string,
	url: string | undefined,
): number {
	const up = ancestors(nodes, link);
	const container = up.find(
		(a) => a.role === "listitem" || a.role === "article",
	);
	const inside = container ? descendants(nodes, container) : [];
	const own = descendants(nodes, link);
	const said = (n: Node) => (n.name || n.text || "").trim();
	if (
		AD_TEXT.test(title.trim()) ||
		AD_URL.test(url ?? "") ||
		[...up.slice(0, 3), ...inside].some((n) => AD_TEXT.test(said(n)))
	)
		return 3;
	if (
		FACET.test(title.trim()) ||
		CHROME_ROLES.includes(link.role) ||
		up.some((a) => CHROME_ROLES.includes(a.role)) ||
		SITE_CHROME.test(title.trim()) ||
		channelUrl(url)
	)
		return 2;
	if (inLinkCloud(nodes, link)) return 1;
	if (siteRoot(url) || noticeBeside(nodes, link, inside)) return 1;
	if (
		up.some((a) => a.role === "heading") ||
		own.some((n) => n.role === "heading" || n.role === "img") ||
		[...title].length >= 20
	)
		return 0;
	const beside = inside.some((n) => {
		if (n.index === link.index || (n.index < link.end && n.index > link.index))
			return false;
		if (n.role === "heading" || n.role === "img") return true;
		const t = said(n);
		return (
			(n.role === "text" || n.role === "paragraph") &&
			[...t].length >= 2 &&
			!/^["|｜・\s]+$/.test(t) &&
			!title.includes(t)
		);
	});
	return beside ? 0 : 1;
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
