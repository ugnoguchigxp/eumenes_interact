import { InteractStoreError } from "./errors.ts";

/**
 * Input validation shared by the store functions. These tables never hold input values, cookies,
 * tokens or authenticated URLs (plan.md §14), so what can be refused by shape is refused here.
 */

export function invalid(field: string): InteractStoreError {
	return new InteractStoreError("invalid_input", field);
}

const ID = /^[\x21-\x7e]{1,128}$/;

/** Owners and host-issued ids: printable ASCII without spaces. */
export function requireId(value: unknown, field: string): string {
	if (typeof value !== "string" || !ID.test(value)) throw invalid(field);
	return value;
}

/** UTC ISO 8601 with a `Z`, so stored timestamps compare as text. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function requireTimestamp(value: unknown, field: string): string {
	if (typeof value !== "string" || !TIMESTAMP.test(value)) {
		throw invalid(field);
	}
	return value;
}

export function requireInteger(
	value: unknown,
	field: string,
	min: number,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min
	) {
		throw invalid(field);
	}
	return value;
}

export function requireText(
	value: unknown,
	field: string,
	max: number,
): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) {
		throw invalid(field);
	}
	return value;
}

export function optionalText(
	value: unknown,
	field: string,
	max: number,
): string | null {
	return value === undefined ? null : requireText(value, field, max);
}

/** A fixed classification code: lowercase words, digits, `_`, `.`. */
export function requireCode(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9_.]{0,63}$/.test(value)) {
		throw invalid(field);
	}
	return value;
}

/** A host-supplied digest or marker string. */
export function requireDigest(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9:_+/=.-]{1,128}$/.test(value)) {
		throw invalid(field);
	}
	return value;
}

const LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
const ORIGIN = new RegExp(
	`^(https?)://(${LABEL}(\\.${LABEL})*|\\[[0-9a-f:.]+\\])(?::(?<port>[1-9][0-9]{0,4}))?$`,
);

/**
 * A normalized origin: lowercase `http(s)://host[:port]`, no userinfo, path, query or fragment, no
 * default port. `URL` is not available to this package; the host normalizes with it before calling.
 */
export function requireOrigin(value: unknown): string {
	if (typeof value !== "string" || value.length > 270) {
		throw new InteractStoreError("invalid_origin");
	}
	const match = ORIGIN.exec(value);
	if (match === null) throw new InteractStoreError("invalid_origin");
	const portText = match.groups?.["port"];
	const port = portText === undefined ? null : Number(portText);
	if (port !== null) {
		const isDefault =
			(match[1] === "http" && port === 80) ||
			(match[1] === "https" && port === 443);
		if (port > 65535 || isDefault)
			throw new InteractStoreError("invalid_origin");
	}
	return value;
}

/** The origin of an absolute URL without parsing it as a URL, or `null` when it is not http(s). */
export function originOfUrl(url: string): string | null {
	const match = /^(https?):\/\/(?:[^/?#@]*@)?([^/?#]+)/i.exec(url);
	if (match === null) return null;
	const origin = `${(match[1] ?? "").toLowerCase()}://${(match[2] ?? "").toLowerCase()}`;
	try {
		return requireOrigin(origin);
	} catch {
		return null;
	}
}

export type FlatValue = string | number | boolean;
export type FlatFields = Readonly<Record<string, FlatValue>>;

/** A key that suggests a credential never becomes a stored field. */
const SECRET_KEY =
	/pass(word|wd)?|secret|token|cookie|authori[sz]ation|credential/i;
/** Runtime refs and coordinates are not persistent locators (plan.md §7.3). */
const RUNTIME_KEYS = new Set(["ref", "targetRef", "handle", "x", "y"]);
const URL_WITH_USERINFO = /:\/\/[^/\s]*@/;
/** A URL with a query or fragment can carry a signed or token value (plan.md §14). */
const URL_WITH_QUERY = /[a-z][a-z0-9+.-]*:\/\/[^\s]*[?#]/i;

/**
 * A small flat map (locator fields, applicability conditions). Returned with sorted keys so the same
 * content always serializes to the same JSON.
 */
export function flatFields(
	value: unknown,
	field: string,
	options: { nonEmpty: boolean },
): FlatFields {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalid(field);
	}
	const entries = Object.entries(value);
	if (entries.length > 16 || (options.nonEmpty && entries.length === 0)) {
		throw invalid(field);
	}
	const sorted: Record<string, FlatValue> = {};
	for (const [key, item] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (
			!/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(key) ||
			SECRET_KEY.test(key) ||
			RUNTIME_KEYS.has(key)
		) {
			throw invalid(field);
		}
		const ok =
			(typeof item === "string" &&
				item.length <= 512 &&
				!URL_WITH_USERINFO.test(item) &&
				!URL_WITH_QUERY.test(item)) ||
			(typeof item === "number" && Number.isFinite(item)) ||
			typeof item === "boolean";
		if (!ok) throw invalid(field);
		sorted[key] = item as FlatValue;
	}
	return sorted;
}

export function toJson(value: unknown, field: string): string {
	const json = JSON.stringify(value);
	if (typeof json !== "string") throw invalid(field);
	return json;
}

/** Clamps a list limit to a sane range. */
export function listLimit(value: number | undefined): number {
	if (value === undefined) return 100;
	return Math.min(Math.max(Math.trunc(value), 1), 1000);
}
