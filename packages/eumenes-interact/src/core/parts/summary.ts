import type {
	FormField,
	ItemRecord,
	ItemResolution,
	PageSummary,
} from "../../contracts/parts.ts";
import type { RawObservation } from "../../contracts/observation.ts";
import { clip, placeOf } from "../shared/text.ts";
import { collect, pageItem } from "./items.ts";
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
	// An unnamed link to an address a named link also goes to (a video's thumbnail beside its title) adds
	// nothing the model can choose by; the named one stands for both. Ids are unchanged.
	const named = new Set(
		records
			.filter((r) => r.role === "link" && r.name && r.url)
			.map((r) => r.url),
	);
	const listed = records.filter(
		(r) => !(r.role === "link" && !r.name && r.url && named.has(r.url)),
	);
	const shown = capItems(listed, options.maxItems);
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
				shown.length < listed.length || headings.length > options.maxHeadings,
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
/** Roles whose name is the text they show (a table cell says "初出：" in its name, not in a text child). */
const NAMED_TEXT = [
	"paragraph",
	"cell",
	"gridcell",
	"rowheader",
	"columnheader",
	"term",
	"definition",
];

/**
 * A hit that is only a label ( such as "出版年") is widened to the nearest enclosing block that says more (its row,
 * its label-and-value pair), so the value comes back with the label. A block longer than the snippet is not
 * taken: the hit stays as it was.
 */
function widen(
	nodes: readonly Node[],
	node: Node,
	text: string,
	wanted: string,
): string {
	// Only a hit that is little more than the query itself (a label) is widened; a sentence already says enough.
	if (fold(text).length > wanted.length + 4) return text;
	for (const a of ancestors(nodes, node)) {
		if (LANDMARK_STOP.includes(a.role)) break;
		const wider = textOf(nodes, a);
		if (wider.length > SNIPPET_CHARS) break;
		// A row that says little more than its label has its figures in the rows below (an infobox).
		if (a.role === "row" && fold(wider).length <= 2 * wanted.length + 4)
			return withNextRows(nodes, a, wider.length > text.length ? wider : text);
		if (wider.length > text.length && fold(wider).includes(fold(text)))
			return wider;
	}
	return text;
}
/**
 * A row that holds only the label (an infobox "人口" header whose figures sit in the rows below it, as on
 * Wikipedia) brings the next rows of its table, up to the snippet length.
 */
function withNextRows(nodes: readonly Node[], row: Node, text: string): string {
	let out = text;
	let taken = 0;
	for (const n of nodes) {
		if (taken >= 3) break;
		if (n.index < row.end || n.parent !== row.parent || n.role !== "row")
			continue;
		const more = textOf(nodes, n);
		if (!more) continue;
		if (out.length + 1 + more.length > SNIPPET_CHARS) break;
		out = `${out} ${more}`;
		taken++;
	}
	return out;
}
/** A link or other named item inside a table row: its row (the values beside it) is what a find wants. */
function inRow(nodes: readonly Node[], node: Node): boolean {
	for (const a of ancestors(nodes, node)) {
		if (a.role === "row") return true;
		if (a.role === "table" || LANDMARK_STOP.includes(a.role)) return false;
	}
	return false;
}
const LANDMARK_STOP = [
	"main",
	"navigation",
	"banner",
	"contentinfo",
	"complementary",
	"region",
	"table",
	"list",
	"article",
];
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
		const text =
			own ||
			(NAMED_TEXT.includes(node.role) || inRow(c.nodes, node) ? node.name : "");
		if (!text || !fold(text).includes(wanted)) continue;
		const sentence = inlineSentence(c.nodes, node);
		const snippet = sentence
			? around(sentence, wanted)
			: clip(widen(c.nodes, node, text, wanted), SNIPPET_CHARS);
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

/** Roles that sit inside a sentence: a paragraph's text is split around them in the snapshot. */
const INLINE_ROLES = [
	"code",
	"strong",
	"emphasis",
	"link",
	"mark",
	"subscript",
	"superscript",
	"time",
	"insertion",
	"deletion",
];
const SENTENCE_BLOCKS = [
	"paragraph",
	"listitem",
	"cell",
	"gridcell",
	"definition",
	"blockquote",
	"caption",
	"generic",
];

/**
 * A text hit whose block also holds inline pieces (`code`, `strong`, a link): the block's whole sentence,
 * joined in order, so a sentence is not cut at the inline code (Rust docs, 2026-11-04). "" when the hit is
 * not such a piece of a sentence.
 */
function inlineSentence(nodes: readonly Node[], node: Node): string {
	const block = node.parent >= 0 ? nodes[node.parent]! : undefined;
	if (!block || !SENTENCE_BLOCKS.includes(block.role)) return "";
	const kids = nodes.filter((n) => n.parent === block.index);
	if (kids.length < 2) return "";
	if (!kids.every((n) => n.role === "text" || INLINE_ROLES.includes(n.role)))
		return "";
	if (!kids.some((n) => n.role !== "text")) return "";
	if (!kids.includes(node) && node.role !== "text") return "";
	const joined = kids
		.map((n) => {
			let raw = n.text || n.name || textOf(nodes, n);
			// Snapshot / a11y trees sometimes wrap a code token in ASCII quotes ("false"); keep the token.
			if (n.role === "code") {
				const t = raw.trim();
				if (
					(t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
					(t.startsWith("'") && t.endsWith("'") && t.length >= 2)
				) {
					const inner = t.slice(1, -1);
					if (/^[\w.<>()[\]|?!,;:/`+-]+$/.test(inner)) return inner;
				}
			}
			// A following text node often keeps the YAML/a11y closing quote (`", the element…`).
			if (n.role === "text") {
				raw = raw.replace(/^["'],\s*/, ", ").replace(/["']$/, "");
			}
			return raw;
		})
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.replace(/\s+([.,;:!?])/g, "$1")
		.replace(/\s*,\s*/g, ", ")
		.trim();
	return joined;
}

/** The snippet of a long sentence around the query; a short one whole. */
function around(text: string, wanted: string): string {
	if (text.length <= SNIPPET_CHARS) return text;
	const at = Math.max(0, fold(text).indexOf(wanted));
	const start = Math.max(0, Math.min(at - 60, text.length - SNIPPET_CHARS));
	const piece = clip(text.slice(start), SNIPPET_CHARS);
	return start > 0 ? `…${piece}` : piece;
}

/** The text a node's subtree shows: its own name or text, else its descendants'. */
export function textOf(nodes: readonly Node[], node: Node): string {
	if (node.name) return node.name;
	if (node.text) return node.text;
	return descendants(nodes, node)
		.map((n) => n.name || n.text)
		.filter(Boolean)
		.join(" ");
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
