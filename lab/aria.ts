/**
 * The accessibility snapshot text of the platforms, read in one place so no other code assumes one platform's
 * spelling. Two shapes are understood:
 * - Playwright MCP: `- link "name" [cursor=pointer] [ref=e3]:` with the destination on a child line
 *   `- /url: /path`;
 * - the inline spelling: `- link "name" [ref=e27, url=https://…]`, attributes in one bracket and the
 *   destination inside it, a compact tree without paragraph text. No adopted platform writes it today; the
 *   parser keeps reading it so a future platform's snapshot needs no change here.
 * Both are indented by two spaces per level, and an element is addressed by its `ref` (opaque; only the
 * observation that showed it can use it).
 */

export type AriaNode = {
	role: string;
	name: string | null;
	ref: string | null;
	/** The link's destination: an inline `url=` attribute, or the `- /url:` line under it. */
	url: string | null;
	parents: AriaNode[];
};

export const normalize = (s: string) =>
	s.normalize("NFKC").trim().replace(/\s+/g, " ");

/** `- link "name" [..] [..]:` and `- main [ref=e7]:`; `- text:` and `- /url:` lines are no element. */
const LINE =
	/^(\s*)- ([A-Za-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::.*)?$/;
const URL_LINE = /^\s*- \/url:\s*(.*?)\s*$/;
/** `ref=eN` as an attribute of any bracket: first (`[ref=e3]`) or after others (`[checked=false, ref=e3]`). */
const REF = /(?:\[|,\s*)ref=([A-Za-z0-9_-]+)/;
const REF_ALL = /(?:\[|,\s*)ref=([A-Za-z0-9_-]+)/g;
/** `url=…` up to the next `, attr=` or the end of the bracket (a destination may itself hold commas). */
const INLINE_URL = /(?:\[|,\s*)url=(.*?)(?=,\s*[A-Za-z][\w-]*=|\]|$)/;

/** Every ref the body shows, in order (the actionable set of an observation). */
export const refsOf = (body: string): string[] =>
	[...body.matchAll(REF_ALL)].map((m) => m[1]!);

export function parseAria(body: string): AriaNode[] {
	const nodes: AriaNode[] = [];
	const stack: { indent: number; node: AriaNode }[] = [];
	for (const raw of body.split("\n")) {
		const link = URL_LINE.exec(raw);
		if (link) {
			// The destination of the link just above.
			const owner = nodes.at(-1);
			if (owner && owner.url === null) owner.url = link[1] ?? null;
			continue;
		}
		const m = LINE.exec(raw.replace(/\t/g, "  "));
		if (!m) continue;
		// `- text:` is page text, not an element.
		if (m[2] === "text") continue;
		const indent = m[1]!.length;
		while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
		const attributes = m[4] ?? "";
		const node: AriaNode = {
			role: m[2]!,
			name: m[3] === undefined ? null : normalize(m[3].replace(/\\(.)/g, "$1")),
			ref: REF.exec(attributes)?.[1] ?? null,
			url: INLINE_URL.exec(attributes)?.[1]?.trim() || null,
			parents: stack.map((s) => s.node),
		};
		nodes.push(node);
		stack.push({ indent, node });
	}
	return nodes;
}
