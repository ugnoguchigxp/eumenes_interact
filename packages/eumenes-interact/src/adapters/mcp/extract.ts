import { AdapterError } from "../../contracts/adapter.ts";
import type { ExtractedContent } from "../../contracts/observation.ts";

/**
 * `page.extract`: the main text of a page by a fixed function run through `browser_evaluate`.
 * No input is interpolated into the function text; the cap is applied here, after the read.
 */

/** The adapter's upper bound on returned text, whatever the caller asks for. */
export const EXTRACT_HARD_MAX_CHARS = 50_000;
const TITLE_MAX_CHARS = 500;
const URL_MAX_CHARS = 8192;

/**
 * Reads the original tree (no clone), so computed `display` is available: nodes that are dropped,
 * `[hidden]`, `aria-hidden="true"` or `display:none` are skipped with their subtree. Block elements
 * and `<br>` become newlines, spaces collapse, three or more newlines become two.
 *
 * Root, when no element is given (generic order, no site-specific selectors): the visible `article`
 * with the most text, else `main`/`[role=main]`, else the visible `div`/`section` outside
 * nav/header/footer/aside with the most text, else `body`. "Most text" is measured on the extracted
 * text of the 20 candidates with the longest `textContent`; for blocks, the deepest candidate that
 * holds at least 90% of the longest one wins, so a wrapper around the content is not picked over it.
 * The form element is dropped like the other chrome, as specified.
 */
const EXTRACT_BODY = `(el) => {
  const DROP = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'CANVAS', 'FORM']);
  const CHROME = ['NAV', 'HEADER', 'FOOTER', 'ASIDE'];
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);
  const hidden = (n) => n.getAttribute('hidden') !== null || n.getAttribute('aria-hidden') === 'true' || getComputedStyle(n).display === 'none';
  const parts = [];
  const walk = (n, pre) => {
    if (n.nodeType === 3) { parts.push(pre ? n.textContent : n.textContent.replace(/\\s+/g, ' ')); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toUpperCase();
    if (DROP.has(tag) || hidden(n)) return;
    if (tag === 'BR') { parts.push('\\n'); return; }
    const block = BLOCK.has(tag);
    if (block) parts.push('\\n');
    for (const c of n.childNodes) walk(c, pre || tag === 'PRE');
    if (block) parts.push('\\n');
  };
  const read = (root) => {
    parts.length = 0;
    const pre = root.tagName.toUpperCase() === 'PRE';
    for (const c of root.childNodes) walk(c, pre);
    return parts.join('').replace(/[^\\S\\n]+/g, ' ').replace(/ ?\\n ?/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  };
  const inChrome = (n) => {
    for (let p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) if (CHROME.includes(p.tagName.toUpperCase())) return true;
    return false;
  };
  const pick = (nodes, deep) => {
    const scored = nodes
      .filter((n) => n.getClientRects().length > 0)
      .sort((a, b) => b.textContent.length - a.textContent.length)
      .slice(0, 20)
      .map((n) => ({ text: read(n) }))
      .filter((x) => x.text.length > 0);
    if (scored.length === 0) return null;
    const max = Math.max(...scored.map((x) => x.text.length));
    return scored.filter((x) => x.text.length >= (deep ? max * 0.9 : max)).sort((a, b) => a.text.length - b.text.length)[0];
  };
  let root = 'target';
  let text;
  if (el) text = read(el);
  else {
    let hit = pick(Array.from(document.querySelectorAll('article')), false);
    if (hit) root = 'article';
    else if ((hit = pick(Array.from(document.querySelectorAll('main, [role="main"]')), false))) root = 'main';
    else if ((hit = pick(Array.from(document.querySelectorAll('div, section')).filter((n) => !inChrome(n)), true))) root = 'largest-block';
    else { root = 'body'; hit = { text: document.body ? read(document.body) : '' }; }
    text = hit.text;
  }
  return { url: location.href, title: String(document.title).slice(0, ${TITLE_MAX_CHARS}), text: text.slice(0, ${EXTRACT_HARD_MAX_CHARS}), charCount: text.length, root };
}`;
export const EXTRACT_TARGET_FUNCTION = EXTRACT_BODY;
export const EXTRACT_PAGE_FUNCTION = `() => (${EXTRACT_BODY})(null)`;

const ROOTS: readonly string[] = [
	"target",
	"article",
	"main",
	"largest-block",
	"body",
];
const KEYS = new Set(["url", "title", "text", "charCount", "root"]);

/** The cap in force: what the caller asked for, never above the hard bound. */
export function extractCap(maxChars: number): number {
	if (!Number.isSafeInteger(maxChars) || maxChars < 1)
		throw new AdapterError("invalid_max_chars", false);
	return Math.min(maxChars, EXTRACT_HARD_MAX_CHARS);
}

/**
 * Validates what the function returned and applies the cap. `targeted` says whether an element was
 * named: the root must then be `target`, and never otherwise.
 */
export function parseExtraction(
	result: string | undefined,
	targeted: boolean,
	cap: number,
): ExtractedContent {
	const bad = () => new AdapterError("mcp_response_unrecognized", false);
	let value: unknown;
	try {
		value = JSON.parse(
			(result ?? "").replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""),
		);
	} catch {
		throw bad();
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw bad();
	const { url, title, text, charCount, root } = value as Record<
		string,
		unknown
	>;
	if (
		!Object.keys(value).every((key) => KEYS.has(key)) ||
		typeof url !== "string" ||
		url.length > URL_MAX_CHARS ||
		typeof title !== "string" ||
		title.length > TITLE_MAX_CHARS ||
		typeof text !== "string" ||
		text.length > EXTRACT_HARD_MAX_CHARS ||
		typeof charCount !== "number" ||
		!Number.isSafeInteger(charCount) ||
		charCount < text.length ||
		typeof root !== "string" ||
		!ROOTS.includes(root) ||
		(root === "target") !== targeted
	)
		throw bad();
	const truncated = charCount > Math.min(text.length, cap);
	let cut = text.slice(0, cap);
	// A cut must not leave half of a surrogate pair.
	if (truncated && /[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
	return {
		...(url !== "" ? { url } : {}),
		...(title !== "" ? { title } : {}),
		text: cut,
		charCount,
		truncated,
		root: root as ExtractedContent["root"],
	};
}

/**
 * `page.extract` on a platform that can only read an element's text (no function can run on an
 * element): the platform's text for the named element, normalised like the fixed function does
 * (spaces collapse, three or more newlines become two, trimmed). Nothing inside the element is
 * dropped, unlike the function; `root` is always `target`.
 */
export function extractionFromText(
	raw: string,
	page: { url?: string; title?: string },
	cap: number,
): ExtractedContent {
	const text = raw
		.replace(/[^\S\n]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const known = text.slice(0, EXTRACT_HARD_MAX_CHARS);
	const truncated = text.length > Math.min(known.length, cap);
	let cut = known.slice(0, cap);
	if (truncated && /[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
	return {
		...(page.url ? { url: page.url.slice(0, URL_MAX_CHARS) } : {}),
		...(page.title ? { title: page.title.slice(0, TITLE_MAX_CHARS) } : {}),
		text: cut,
		charCount: text.length,
		truncated,
		root: "target",
	};
}
