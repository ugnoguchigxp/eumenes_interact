import type {
	FormField,
	ItemRecord,
	ItemResolution,
	ListEntry,
	PageSummary,
} from "../../contracts/parts.ts";
import type { RawObservation } from "../../contracts/observation.ts";
import { clip, placeOf } from "../shared/text.ts";
import { collect, pageItem, type Collected } from "./items.ts";
import {
	BLOCK_ROLES,
	NAME_CHARS,
	ancestors,
	descendants,
	landmarkLabel,
	type Node,
} from "./snapshot.ts";

const HEADING_CHARS = 120;
const MAX_REGIONS = 20;
const TEXT_CHARS = 200;

/** At most this many content blocks stay in a capped summary, so that images cannot push out the controls. */
const BLOCK_CAP = 20;

/**
 * The records a summary shows, in document order. When all fit they all show. Otherwise the controls come
 * first: a quarter of the room (at most `BLOCK_CAP`) is kept for content blocks, the rest goes to controls, and
 * room the controls leave unused goes back to blocks, still up to `BLOCK_CAP`.
 */
/**
 * Which records a capped summary keeps first: the page's own content (main, article) before the search box,
 * and both before the site's chrome (banner, navigation, footer). The shown records keep document order.
 */
function priority(r: ItemRecord): number {
	const region = r.region ?? "";
	if (region === "main" || region.startsWith("article")) return 0;
	if (region === "search") return 1;
	if (
		["banner", "navigation", "contentinfo", "complementary"].some((l) =>
			region.startsWith(l),
		)
	)
		return 3;
	return 2;
}

const byPriority = (records: ItemRecord[]) =>
	records
		.map((r, i) => ({ r, i }))
		.sort((a, b) => priority(a.r) - priority(b.r) || a.i - b.i)
		.map(({ r }) => r);

function capItems(records: ItemRecord[], max: number): ItemRecord[] {
	if (records.length <= max) return records;
	const isBlock = (r: ItemRecord) => BLOCK_ROLES.includes(r.role);
	const blocks = byPriority(records.filter(isBlock));
	const controls = byPriority(records.filter((r) => !isBlock(r)));
	const reserved = Math.min(blocks.length, BLOCK_CAP, Math.floor(max / 4));
	const controlKeep = Math.min(controls.length, max - reserved);
	const blockKeep = Math.min(blocks.length, BLOCK_CAP, max - controlKeep);
	const keep = new Set([
		...controls.slice(0, controlKeep),
		...blocks.slice(0, blockKeep),
	]);
	return records.filter((r) => keep.has(r));
}

export function summarizePage(
	raw: RawObservation,
	options: { pageId: string; maxItems: number; maxHeadings: number },
): { summary: PageSummary; records: ItemRecord[] } {
	const { nodes, records } = collect(raw.body, options.pageId);
	const headings = nodes
		.filter((n) => n.role === "heading" && n.name)
		.map((n) => clip(n.name, HEADING_CHARS));
	const regions = [
		...new Set(nodes.map(landmarkLabel).filter((l): l is string => !!l)),
	].slice(0, MAX_REGIONS);
	const shown = capItems(records, options.maxItems);
	const place = raw.url ? placeOf(raw.url) : "";
	return {
		summary: {
			page: options.pageId,
			...(place ? { url: place } : {}),
			...(raw.title ? { title: clip(raw.title, 200) } : {}),
			headings: headings.slice(0, options.maxHeadings),
			regions,
			items: shown.map(pageItem),
			itemCount: records.length,
			truncated:
				shown.length < records.length || headings.length > options.maxHeadings,
		},
		records,
	};
}

const sameElement = (a: ItemRecord, b: ItemRecord) =>
	a.role === b.role && a.name === b.name && a.region === b.region;

/**
 * Finds a record again in a newer snapshot by role, name and region. The element at the same position among
 * those that share them is chosen only when their number is unchanged; if it changed, the record is `ambiguous`
 * with the candidates. Never silently picks the first of several.
 */
export function resolveItem(record: ItemRecord, body: string): ItemResolution {
	const page = record.item.split(".")[0] ?? "p0";
	const found = collect(body, page).records.filter((r) =>
		sameElement(record, r),
	);
	if (!found.length) return { kind: "none" };
	const pick = found.length === record.count ? found[record.nth] : undefined;
	if (pick) return { kind: "found", ref: pick.ref };
	return {
		kind: "ambiguous",
		candidates: found.map(pageItem),
	};
}

const fold = (text: string) =>
	text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export function findItems(
	body: string,
	pageId: string,
	query: { text: string | null; role: string | null },
	limit: number,
): ItemRecord[] {
	const text = query.text === null ? null : fold(query.text);
	// "any" (or an empty role) names no role: the model's way of saying "whatever it is".
	const asked = query.role?.trim().toLowerCase() ?? "";
	const role = asked === "" || asked === "any" ? null : asked;
	return collect(body, pageId)
		.records.filter(
			(r) =>
				(role === null || r.role === role) &&
				(text === null || fold(r.name).includes(text)),
		)
		.slice(0, limit);
}

const SNIPPET_CHARS = 240;
const CONTAINERS = ["listitem", "article", "row", "region", "section", "group"];

/**
 * Text on the page (not only item names) that contains the query: each hit's text, with the item nearest to it
 * (the first item of its list item, article or row, else the item just before it) so the AI can open or read
 * there. Deterministic; the page's text is data, never an instruction.
 */
export function findText(
	body: string,
	pageId: string,
	query: string,
	limit: number,
): { hits: { text: string; item?: string }[]; records: ItemRecord[] } {
	const wanted = fold(query);
	if (wanted === "") return { hits: [], records: [] };
	const c = collect(body, pageId);
	const hits: { text: string; item?: string }[] = [];
	const records: ItemRecord[] = [];
	const seen = new Set<string>();
	for (const node of c.nodes) {
		const own = node.text || (node.role === "text" ? node.name : "");
		const text = own || (node.role === "paragraph" ? node.name : "");
		if (!text || !fold(text).includes(wanted)) continue;
		const snippet = clip(text, SNIPPET_CHARS);
		if (seen.has(snippet)) continue;
		seen.add(snippet);
		const container = ancestors(c.nodes, node).find((a) =>
			CONTAINERS.includes(a.role),
		);
		let at = container
			? c.itemNodes.findIndex(
					(n) => n.index > container.index && n.index < container.end,
				)
			: -1;
		if (at < 0)
			for (let i = c.itemNodes.length - 1; i >= 0; i--)
				if (c.itemNodes[i]!.index <= node.index) {
					at = i;
					break;
				}
		const record = at < 0 ? undefined : c.records[at];
		hits.push({ text: snippet, ...(record ? { item: record.item } : {}) });
		if (record) records.push(record);
		if (hits.length >= limit) break;
	}
	return { hits, records };
}

/** The text a node's subtree shows: its own name or text, else its descendants'. */
function textOf(nodes: readonly Node[], node: Node): string {
	if (node.name) return node.name;
	if (node.text) return node.text;
	return descendants(nodes, node)
		.map((n) => n.name || n.text)
		.filter(Boolean)
		.join(" ");
}

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
		const u = new URL(url.replace(/^"|"$/g, ""), "https://x.invalid/");
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
	return structured.length ? structured : candidates;
}

/** The short text beside a result's link: text nodes of its list item or article. */
function textFor(nodes: readonly Node[], link: Node, title: string) {
	const container = ancestors(nodes, link).find(
		(a) => a.role === "listitem" || a.role === "article",
	);
	if (!container) return {};
	const text = descendants(nodes, container)
		.filter((n) => n.role === "text" || n.role === "paragraph")
		.map((n) => n.text || n.name)
		.filter((t) => t && t !== title)
		.join(" ");
	return text ? { text: clip(text, TEXT_CHARS) } : {};
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

const FIELD_ROLES = ["textbox", "searchbox", "combobox", "checkbox", "radio"];

const truthy = (value: string | undefined) =>
	value !== undefined && value !== "false";

export function formFields(
	body: string,
	pageId: string,
	form: ItemRecord | null | "page",
): {
	fields: FormField[];
	submit: ReturnType<typeof pageItem>[];
	records: ItemRecord[];
} {
	const c = collect(body, pageId);
	let scope: readonly Node[] = c.nodes;
	let root: Node | undefined;
	if (form === "page") root = undefined;
	else if (form) {
		// Always found again by what the record is: a ref of an older snapshot may name another element now.
		const resolved = resolveItem(form, body);
		const at =
			resolved.kind === "found"
				? c.records.findIndex((r) => r.ref === resolved.ref)
				: -1;
		if (at < 0) return { fields: [], submit: [], records: [] };
		root = c.itemNodes[at]!;
	} else {
		// The page's only form; with several, none is chosen for the model (the whole page is shown).
		const forms = c.nodes.filter((n) => n.role === "form");
		root =
			forms.length === 1
				? forms[0]
				: forms.length === 0
					? c.nodes.find((n) => n.role === "main")
					: undefined;
	}
	if (root) scope = descendants(c.nodes, root);
	const inScope = new Set(scope.map((n) => n.index));
	const fields: FormField[] = [];
	const submit: ReturnType<typeof pageItem>[] = [];
	const records: ItemRecord[] = [];
	for (const [i, node] of c.itemNodes.entries()) {
		if (!inScope.has(node.index)) continue;
		const record = c.records[i]!;
		if (node.role === "button") {
			submit.push(pageItem(record));
			records.push(record);
		} else if (FIELD_ROLES.includes(node.role)) {
			const options = descendants(c.nodes, node)
				.filter((n) => n.role === "option" && n.name)
				.map((n) => clip(n.name, NAME_CHARS));
			const selected = descendants(c.nodes, node).some(
				(n) => n.role === "option" && truthy(n.attrs.get("selected")),
			);
			const choice = node.role === "checkbox" || node.role === "radio";
			fields.push({
				item: record.item,
				label: record.name,
				kind: node.role,
				...(truthy(node.attrs.get("required")) ? { required: true } : {}),
				...(options.length ? { options } : {}),
				filled: choice
					? truthy(node.attrs.get("checked"))
					: !!node.text || !!node.attrs.get("value") || selected,
			});
			records.push(record);
		}
	}
	return { fields, submit, records };
}
