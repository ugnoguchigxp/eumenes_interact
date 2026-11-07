import { AdapterError } from "../../contracts/adapter.ts";
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
  const raw = tag === 'a' || tag === 'area' ? el.getAttribute('href') : undefined;
  const link = raw === undefined ? {} : { href: raw === null ? null : String(raw).slice(0, 200) };
  const form = el.form || el.closest('form');
  if (!form) return { tag, ...typed, ...role, ...link, inForm: false, submits: false };
  const own = tag === 'input' || tag === 'button' ? method(el.getAttribute('formmethod')) : '';
  const formMethod = own || method(form.method) || 'get';
  const fields = Array.from(form.elements);
  const isSubmitter = (n) => (n.tagName === 'BUTTON' && n.type === 'submit') || (n.tagName === 'INPUT' && (n.type === 'submit' || n.type === 'image'));
  const isTextField = (n) => n.tagName === 'INPUT' && textual.includes(n.type);
  let submits = false;
  if (isSubmitter(el)) submits = true;
  else if (isTextField(el)) submits = fields.some(isSubmitter) || fields.filter(isTextField).length === 1;
  return { tag, ...typed, ...role, ...link, inForm: true, formMethod, submits };
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
	const { tag, type, inForm, formMethod, submits, role, href } =
		evaluated(result);
	if (
		typeof tag !== "string" ||
		tag.length > 40 ||
		typeof inForm !== "boolean" ||
		typeof submits !== "boolean" ||
		(type !== undefined && (typeof type !== "string" || type.length > 40)) ||
		(formMethod !== undefined &&
			(typeof formMethod !== "string" || formMethod.length > 20)) ||
		(role !== undefined && role !== "button") ||
		// An `<a>`/`<area>`'s own href attribute (null when it has none): what a menu item's link goes to,
		// which Playwright MCP's snapshot does not show for role=menuitem (design R18).
		(href !== undefined &&
			href !== null &&
			(typeof href !== "string" || href.length > LOCATOR_VALUE_MAX))
	)
		throw new AdapterError("inspect_invalid", false);
	return {
		tag,
		...(type !== undefined ? { type } : {}),
		...(role === "button" ? { role } : {}),
		...(href !== undefined ? { href } : {}),
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

/** Fixed, read-only DOM enumeration. Arguments are numeric bounds and an observed root, never code. */
export function inspectChoicesFunction(
	offset = 0,
	limit = 20,
	scoped = false,
): string {
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 50
	)
		throw new Error("invalid_inspection_bounds");
	return `${scoped ? "(root)" : "()"} => {
  const scope = ${scoped ? "root" : "document"};
  const PAIR = /([A-Za-z_][\\w.-]{0,30})=([^|&'"\\s;,()<>]{1,100})/g;
  const out = [];
  for (const el of scope.querySelectorAll('a[href], li, option, button, [role=option], [role=menuitem], [role=menuitemradio], [onclick], [data-sort], [data-value]')) {
    const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!text) continue;
    const sources = [el.getAttribute('onclick'), ...[...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.value)];
    const select = el.tagName === 'OPTION' ? el.closest('select') : null;
    if (select && select.name && el.value) sources.push(select.name + '=' + el.value);
    const params = [];
    for (const s of sources) if (s) for (const m of String(s).matchAll(PAIR)) params.push([m[1], m[2]]);
    const href = el.tagName === 'A' && /^https?:/.test(el.href) ? el.href : null;
    out.push({ text: text.slice(0, 200), visible: !!(el.offsetParent || el.getClientRects().length), href, params: params.slice(0, 6) });
  }
  return { count: out.length, options: JSON.stringify(out.slice(${offset}, ${offset + limit})) };
}`;
}
/** Legacy inspection name, now uses the same neutral enumeration. */
export const INSPECT_SORT_FUNCTION = inspectChoicesFunction(0, 8);

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
	return value.slice(0, 50).flatMap((o): SortOption[] => {
		if (typeof o !== "object" || o === null) return [];
		const r = o as Record<string, unknown>;
		const text = str(r.text, 200);
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
