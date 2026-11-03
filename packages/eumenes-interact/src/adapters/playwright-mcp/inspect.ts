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
