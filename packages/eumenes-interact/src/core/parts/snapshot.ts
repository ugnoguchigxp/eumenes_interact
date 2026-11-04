import { refsOf, snapshotNodes } from "../shared/observation.ts";
import { clip } from "../shared/text.ts";

/**
 * The accessibility snapshot as nodes, for both text formats: Playwright MCP (`- link "name" [ref=e3]:` with the
 * destination on a child `- /url:` line) and the bracketed-attribute spelling (`[checked=false, ref=e322]`,
 * `[ref=e27, url=https://…]`). Pure text work; the AI never sees these nodes, only the summaries made from them.
 */

export type Node = {
	index: number;
	level: number;
	role: string;
	name: string;
	ref: string | null;
	/** The link's destination: an inline `url=` attribute or the `- /url:` child line. */
	url: string | null;
	/** Bracket attributes: `checked`, `required`, `level=2`…; a bare flag has the value `true`. */
	attrs: Map<string, string>;
	/** The text after the colon (`- textbox "x" [ref=e5]: value`, `- text: …`, a block scalar's lines). */
	text: string;
	/** Index of the nearest ancestor node (by indentation), or -1. */
	parent: number;
	/** Index after the node's last descendant. */
	end: number;
};

const HEADER = /^(\s*)- ([A-Za-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?(.*)$/s;
const URL_LINE = /^\s*- \/url:\s*(.*?)\s*$/;
const BRACKETS = /^(?: \[[^\]]*\])*/;
/** `url=…` up to the next `, attr=` or the end of the bracket (a destination may itself hold commas). */
const INLINE_URL = /(?:\[|,\s*)url=(.*?)(?=,\s*[A-Za-z][\w-]*=|\]|$)/;

function unquote(raw: string) {
	try {
		return JSON.parse(`"${raw}"`) as string;
	} catch {
		return raw;
	}
}

function attrsOf(brackets: string) {
	const attrs = new Map<string, string>();
	for (const group of brackets.matchAll(/\[([^\]]*)\]/g)) {
		const body = group[1]!.replace(INLINE_URL, "");
		for (const token of body.split(/,\s*|\s+/)) {
			if (!token) continue;
			const at = token.indexOf("=");
			if (at < 0) attrs.set(token, "true");
			else attrs.set(token.slice(0, at), token.slice(at + 1));
		}
	}
	return attrs;
}

export function parseNodes(body: string): Node[] {
	const nodes: Node[] = [];
	const stack: Node[] = [];
	for (const raw of snapshotNodes(body)) {
		const [head = "", ...rest] = raw.lines;
		const m = HEADER.exec(head);
		if (!m) continue;
		const after = m[4] ?? "";
		const brackets = BRACKETS.exec(after)![0];
		const tail = after.slice(brackets.length);
		let text = tail.startsWith(":") ? tail.slice(1).trim() : "";
		const child = rest
			.map((line) => URL_LINE.exec(line))
			.find((found) => found !== null);
		if (text === "|" || text === ">")
			text = rest
				.filter((line) => !URL_LINE.test(line))
				.map((line) => line.trim())
				.join(" ");
		const node: Node = {
			index: nodes.length,
			level: raw.level,
			role: m[2]!.toLowerCase(),
			name: m[3] === undefined ? "" : unquote(m[3]).replace(/\s+/g, " ").trim(),
			ref: refsOf(brackets)[0] ?? null,
			url: (INLINE_URL.exec(brackets)?.[1]?.trim() || child?.[1]) ?? null,
			attrs: attrsOf(brackets),
			text,
			parent: -1,
			end: nodes.length + 1,
		};
		while (stack.length && stack.at(-1)!.level >= node.level) {
			stack.pop()!.end = node.index;
		}
		node.parent = stack.at(-1)?.index ?? -1;
		nodes.push(node);
		stack.push(node);
	}
	for (const open of stack) open.end = nodes.length;
	return nodes;
}

/** The nodes below `node`, in document order. */
export const descendants = (nodes: readonly Node[], node: Node) =>
	nodes.slice(node.index + 1, node.end);

/** The ancestors of a node, nearest first. */
export function ancestors(nodes: readonly Node[], node: Node) {
	const found: Node[] = [];
	for (let p = node.parent; p >= 0; p = nodes[p]!.parent) found.push(nodes[p]!);
	return found;
}

export const LANDMARKS = [
	"banner",
	"navigation",
	"main",
	"complementary",
	"contentinfo",
	"form",
	"search",
	"region",
];

/** The label of a landmark node; `region` counts only when it has a name. */
export function landmarkLabel(node: Node): string | null {
	if (!LANDMARKS.includes(node.role)) return null;
	if (node.role === "region" && !node.name) return null;
	return clip(node.name ? `${node.role} ${node.name}` : node.role, 80);
}

/** The roles the AI may act on. `form` is listed so that `form.inspect` can name a form. */
export const ITEM_ROLES = [
	"link",
	"button",
	"textbox",
	"searchbox",
	"combobox",
	"checkbox",
	"radio",
	"menuitem",
	"tab",
	"form",
];

/**
 * Content blocks: elements that hold content the AI may read or capture as a whole. They get item ids like the
 * controls, but cannot be opened.
 */
export const BLOCK_ROLES = [
	"article",
	"region",
	"main",
	"complementary",
	"table",
	"img",
	"figure",
];

/** Whether a node is an item: a control, or a content block (`region`, `complementary` and `img` only when named). */
export function isItemNode(node: Node) {
	if (node.ref === null) return false;
	if (ITEM_ROLES.includes(node.role)) return true;
	if (!BLOCK_ROLES.includes(node.role)) return false;
	return (
		node.name !== "" || !["region", "complementary", "img"].includes(node.role)
	);
}

export const NAME_CHARS = 120;
export const URL_CHARS = 200;
