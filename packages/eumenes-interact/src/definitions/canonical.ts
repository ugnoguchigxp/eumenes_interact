/**
 * Canonical JSON (the RFC 8785 subset eumenes-memory uses): keys sorted by UTF-16 code units, no whitespace.
 * Numbers are finite and printed as JSON.stringify prints them; members that are `undefined` are left out,
 * as JSON.stringify leaves them out.
 */
export function canonicalJson(value: unknown): string {
	if (typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new TypeError("canonicalJson: non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value))
		return `[${value.map((element) => canonicalJson(element)).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${keys
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new TypeError("canonicalJson: unsupported value");
}
