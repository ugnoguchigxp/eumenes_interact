import { AdapterError } from "../../contracts/adapter.ts";
import { DEFAULT_LEXICON } from "../../core/shared/lexicon.ts";
import type { InspectionResult } from "../../contracts/adapter.ts";

/**
 * Fixed inspections run through `browser_evaluate`. No input is ever interpolated into the
 * function text: the only variable is the `target` ref, which MCP resolves itself.
 */

/**
 * What the HTML says an element does (ported from Eumenes `inspectTarget`): attributes and form
 * membership only, used to judge whether a click or Enter would submit.
 */
const INSPECT_ELEMENT_BODY = `(el) => {
  const method = (v) => { const s = String(v || '').toLowerCase(); return s === 'get' || s === 'post' || s === 'dialog' ? s : ''; };
  const textual = ['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number'];
  if (!el || el === document.body || el === document.documentElement) return { tag: 'body', inForm: false, submits: false };
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' || tag === 'button' ? String(el.type || '').toLowerCase() : '';
  const typed = type ? { type } : {};
  const role = String(el.getAttribute('role') || '').trim().toLowerCase() === 'button' ? { role: 'button' } : {};
  const form = el.form || el.closest('form');
  if (!form) return { tag, ...typed, ...role, inForm: false, submits: false };
  const own = tag === 'input' || tag === 'button' ? method(el.getAttribute('formmethod')) : '';
  const formMethod = own || method(form.method) || 'get';
  const fields = Array.from(form.elements);
  const isSubmitter = (n) => (n.tagName === 'BUTTON' && n.type === 'submit') || (n.tagName === 'INPUT' && (n.type === 'submit' || n.type === 'image'));
  const isTextField = (n) => n.tagName === 'INPUT' && textual.includes(n.type);
  let submits = false;
  if (isSubmitter(el)) submits = true;
  else if (isTextField(el)) submits = fields.some(isSubmitter) || fields.filter(isTextField).length === 1;
  return { tag, ...typed, ...role, inForm: true, formMethod, submits };
}`;
export const INSPECT_TARGET_FUNCTION = INSPECT_ELEMENT_BODY;
export const INSPECT_FOCUSED_FUNCTION = `() => (${INSPECT_ELEMENT_BODY})(document.activeElement)`;

/** The cap on every string `inspectLocator` returns. */
export const LOCATOR_VALUE_MAX = 200;

/**
 * Attribute facts of an observed element for site knowledge (plan.md §5.4): a fixed allowlist, no
 * text content and no values (`value`, `checked`, `selected` are not read). The keys are the
 * attribute names; `formId`, `formName` and `formMethod` describe the owning form.
 */
export const INSPECT_LOCATOR_FUNCTION = `(el) => {
  const cap = (v) => v === null || v === undefined ? null : String(v).slice(0, ${LOCATOR_VALUE_MAX});
  const attr = (n, name) => n && n.getAttribute ? cap(n.getAttribute(name)) : null;
  const none = { tag: 'body', type: null, name: null, id: null, placeholder: null, 'aria-label': null, 'data-testid': null, role: null, autocomplete: null, formId: null, formName: null, formMethod: null };
  if (!el || el === document.body || el === document.documentElement) return none;
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' || tag === 'button' ? cap(String(el.type || '').toLowerCase()) : attr(el, 'type');
  const form = el.form || el.closest('form');
  const m = form ? String(form.getAttribute('method') || '').toLowerCase() : '';
  return {
    tag, type, name: attr(el, 'name'), id: attr(el, 'id'), placeholder: attr(el, 'placeholder'),
    'aria-label': attr(el, 'aria-label'), 'data-testid': attr(el, 'data-testid'), role: attr(el, 'role'),
    autocomplete: attr(el, 'autocomplete'),
    formId: attr(form, 'id'), formName: attr(form, 'name'),
    formMethod: form ? (m === 'get' || m === 'post' || m === 'dialog' ? m : 'get') : null,
  };
}`;

/** The JSON object an evaluate call returned (MCP wraps it in a fence). */
function evaluated(result: string | undefined): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(
			(result ?? "").replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""),
		);
	} catch {
		throw new AdapterError("inspect_invalid", false);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new AdapterError("inspect_invalid", false);
	return value as Record<string, unknown>;
}

/** The facts `inspectTarget` reports; absent optional facts are left out. */
export function parseTargetInspection(
	result: string | undefined,
): InspectionResult {
	const { tag, type, inForm, formMethod, submits, role } = evaluated(result);
	if (
		typeof tag !== "string" ||
		tag.length > 40 ||
		typeof inForm !== "boolean" ||
		typeof submits !== "boolean" ||
		(type !== undefined && (typeof type !== "string" || type.length > 40)) ||
		(formMethod !== undefined &&
			(typeof formMethod !== "string" || formMethod.length > 20)) ||
		(role !== undefined && role !== "button")
	)
		throw new AdapterError("inspect_invalid", false);
	return {
		tag,
		...(type !== undefined ? { type } : {}),
		...(role === "button" ? { role } : {}),
		inForm,
		...(formMethod !== undefined ? { formMethod } : {}),
		submits,
	};
}

const LOCATOR_KEYS = [
	"tag",
	"type",
	"name",
	"id",
	"placeholder",
	"aria-label",
	"data-testid",
	"role",
	"autocomplete",
	"formId",
	"formName",
	"formMethod",
] as const;

/** Only the allowlisted keys come back; each is a string (cut at the cap) or null. */
export function parseLocatorInspection(
	result: string | undefined,
): InspectionResult {
	const value = evaluated(result);
	const facts: Record<string, string | null> = {};
	for (const key of LOCATOR_KEYS) {
		const fact = value[key];
		if (fact !== null && typeof fact !== "string")
			throw new AdapterError("inspect_invalid", false);
		facts[key] = fact === null ? null : fact.slice(0, LOCATOR_VALUE_MAX);
	}
	if (facts.tag === null) throw new AdapterError("inspect_invalid", false);
	return facts;
}

/**
 * The largest `<video>` of the page: its playback position and state only. No page text and no model input;
 * reading it changes nothing (it neither plays nor pauses).
 */
export const INSPECT_MEDIA_FUNCTION = `() => {
  const vs = [...document.querySelectorAll('video')];
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const v = vs.sort((a, b) => area(b) - area(a))[0];
  if (!v) return { found: false };
  const finite = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
  return { found: true, currentTime: finite(v.currentTime), duration: finite(v.duration),
    paused: v.paused, ended: v.ended, readyState: v.readyState,
    adShowing: !!v.closest('.ad-showing, .ad-interrupting') };
}`;

/** Only the fixed playback facts come back, each of its own type. */
export function parseMediaInspection(
	result: string | undefined,
): InspectionResult {
	const v = evaluated(result);
	if (typeof v.found !== "boolean")
		throw new AdapterError("inspect_invalid", false);
	if (!v.found) return { found: false };
	const num = (x: unknown) =>
		x === null || typeof x === "number" ? x : undefined;
	const currentTime = num(v.currentTime);
	const duration = num(v.duration);
	if (
		currentTime === undefined ||
		duration === undefined ||
		typeof v.paused !== "boolean" ||
		typeof v.ended !== "boolean" ||
		typeof v.readyState !== "number" ||
		(v.adShowing !== undefined && typeof v.adShowing !== "boolean")
	)
		throw new AdapterError("inspect_invalid", false);
	return {
		found: true,
		currentTime,
		duration,
		paused: v.paused,
		ended: v.ended,
		readyState: v.readyState,
		adShowing: v.adShowing === true,
	};
}

/**
 * The page's list-ordering choices, also those a custom dropdown keeps hidden or out of the accessibility
 * tree (a `<li onclick>` under "並べ替え："). An element counts when its own short text names an order
 * ("価格の安い順", "Price: low to high") and a sort label ("並べ替え", "表示順", "Sort") is on it or within five
 * ancestors. For each: its text, whether it shows, its link, and the `key=value` pairs its link, handler or
 * data attributes carry (what choosing it would put in the URL). Reading changes nothing. No model input.
 */
export const INSPECT_SORT_FUNCTION = `() => {
  const ORDER = new RegExp(${JSON.stringify(DEFAULT_LEXICON.inspectSortChoice.source)}, ${JSON.stringify(DEFAULT_LEXICON.inspectSortChoice.flags)});
  const LABEL = new RegExp(${JSON.stringify(DEFAULT_LEXICON.inspectSortLabel.source)}, ${JSON.stringify(DEFAULT_LEXICON.inspectSortLabel.flags)});
  const PAIR = /([A-Za-z_][\\w.-]{0,30})=([^|&'"\\s;,()<>]{1,100})/g;
  const own = (el) => {
    if (el.tagName === 'OPTION' || el.children.length === 0) return el.textContent || '';
    return [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
  };
  const labelled = (el) => {
    for (let p = el, i = 0; p && p.nodeType === 1 && i < 6; p = p.parentElement, i++) {
      const s = [p.getAttribute('aria-label'), p.id, typeof p.className === 'string' ? p.className : '', p.getAttribute('name')].join(' ');
      if (LABEL.test(s)) return true;
      if (i > 0) for (const c of p.children) if (c !== el && c.children.length === 0 && LABEL.test((c.textContent || '').slice(0, 40))) return true;
    }
    return false;
  };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('a[href], li, option, button, [role=option], [role=menuitem], [role=menuitemradio], [onclick], [data-sort], [data-value]')) {
    const text = own(el).replace(/\\s+/g, ' ').trim();
    if (!text || text.length > 24 || !ORDER.test(text) || seen.has(text) || !labelled(el)) continue;
    seen.add(text);
    const sources = [el.getAttribute('onclick'), ...[...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.value)];
    const select = el.tagName === 'OPTION' ? el.closest('select') : null;
    if (select && select.name && el.value) sources.push(select.name + '=' + el.value);
    const params = [];
    for (const s of sources) if (s) for (const m of String(s).matchAll(PAIR)) params.push([m[1], m[2]]);
    const href = el.tagName === 'A' && /^https?:/.test(el.href) ? el.href : null;
    out.push({ text, visible: !!(el.offsetParent || el.getClientRects().length), href, params: params.slice(0, 6) });
    if (out.length >= 8) break;
  }
  return { count: out.length, options: JSON.stringify(out) };
}`;

/** One ordering choice `inspectSort` found. The text is page text (untrusted), cut short. */
export type SortOption = {
	text: string;
	visible: boolean;
	href: string | null;
	params: [string, string][];
};

/** The count and the options (as JSON text, the only shape an inspection result carries), checked. */
export function parseSortInspection(
	result: string | undefined,
): InspectionResult {
	const { count, options } = evaluated(result);
	if (typeof count !== "number" || typeof options !== "string")
		throw new AdapterError("inspect_invalid", false);
	return { count, options: JSON.stringify(sortOptionsOf(options)) };
}

/** The options of a sort inspection's JSON text; anything malformed is dropped, strings are capped. */
export function sortOptionsOf(json: string): SortOption[] {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	const str = (x: unknown, n: number) =>
		typeof x === "string" ? x.slice(0, n) : null;
	return value.slice(0, 8).flatMap((o): SortOption[] => {
		if (typeof o !== "object" || o === null) return [];
		const r = o as Record<string, unknown>;
		const text = str(r.text, 40);
		if (!text) return [];
		const params = Array.isArray(r.params)
			? r.params.flatMap((p): [string, string][] =>
					Array.isArray(p) &&
					typeof p[0] === "string" &&
					typeof p[1] === "string"
						? [[p[0].slice(0, 32), p[1].slice(0, 100)]]
						: [],
				)
			: [];
		return [
			{
				text,
				visible: r.visible === true,
				href: str(r.href, LOCATOR_VALUE_MAX * 10),
				params: params.slice(0, 6),
			},
		];
	});
}
