/** Shared provider subset. Local Zod validation retains all bounds omitted from the wire schema. */
export function wireSchema(value: unknown): Record<string, unknown> {
	const unsupported = new Set([
		"$schema",
		"minLength",
		"maxLength",
		"minItems",
		"maxItems",
		"minimum",
		"maximum",
		"pattern",
		"format",
	]);
	const visit = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(visit)
			: v && typeof v === "object"
				? Object.fromEntries(
						Object.entries(v)
							.filter(([k]) => !unsupported.has(k))
							.map(([k, x]) => [k, visit(x)]),
					)
				: v;
	return visit(value) as Record<string, unknown>;
}
