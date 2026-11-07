import { z } from "zod";
import { partCallSchema } from "../../contracts/parts.ts";

/**
 * The structured-output JSON Schema of a part call: what Claude's `output_config.format` accepts. Objects stay
 * closed (`additionalProperties: false`), a union is `anyOf`, and the keywords the API does not support
 * (string, number and array constraints, `pattern`) are left out; zod still checks every one of them in
 * `parseStep`. Repeated primitive unions use non-recursive local definitions, keeping the provider's
 * union-type limit without changing the values accepted by the schema.
 */
const UNSUPPORTED = new Set([
	"$schema",
	"pattern",
	"format",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
]);

function sanitize(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(sanitize);
	if (typeof node !== "object" || node === null) return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (UNSUPPORTED.has(key)) continue;
		out[key === "oneOf" ? "anyOf" : key] = sanitize(value);
	}
	if (out.type === "object")
		out.required = Object.keys((out.properties ?? {}) as object);
	return out;
}

type Branch = { properties: { part: { const: string }; args: unknown } };
const branches = (
	sanitize(z.toJSONSchema(partCallSchema)) as { anyOf: Branch[] }
).anyOf;

/** Both providers support local definitions. Factor identical primitive unions (Claude permits 16). */
function compactUnions(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const counts = new Map<string, number>();
	const primitiveUnion = (node: Record<string, unknown>) =>
		Array.isArray(node.anyOf) &&
		node.anyOf.every(
			(n) =>
				n &&
				typeof n === "object" &&
				typeof n.type === "string" &&
				!["object", "array"].includes(n.type),
		);
	const count = (node: unknown): void => {
		if (Array.isArray(node)) {
			node.forEach(count);
			return;
		}
		if (!node || typeof node !== "object") return;
		const obj = node as Record<string, unknown>;
		if (primitiveUnion(obj)) {
			const key = JSON.stringify(obj);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		Object.values(obj).forEach(count);
	};
	count(schema);
	const names = new Map<string, string>();
	const definitions: Record<string, unknown> = {};
	const replace = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(replace);
		if (!node || typeof node !== "object") return node;
		const obj = node as Record<string, unknown>;
		const key = JSON.stringify(obj);
		if (primitiveUnion(obj) && (counts.get(key) ?? 0) > 1) {
			let name = names.get(key);
			if (!name) {
				name = `shared${names.size}`;
				names.set(key, name);
				definitions[name] = obj;
			}
			return { $ref: `#/$defs/${name}` };
		}
		return Object.fromEntries(
			Object.entries(obj).map(([k, v]) => [k, replace(v)]),
		);
	};
	const result = replace(schema) as Record<string, unknown>;
	return Object.keys(definitions).length
		? { ...result, $defs: definitions }
		: result;
}

/**
 * The schema of the part calls whose names are in `parts` (all of them when absent). The root is one object
 * `{part, args}`: `part` is an enum of the names and `args` is the union of the offered parts' closed argument
 * objects, equal shapes listed once. The pairing of a part with its own arguments is not in the schema; zod checks
 * it in `parseStep`, where a mismatch is repaired like any other invalid output.
 */
export function partCallJsonSchemaFor(
	parts?: readonly string[],
): Record<string, unknown> {
	const offered = branches.filter(
		(b) => !parts || parts.includes(b.properties.part.const),
	);
	const args = new Map<string, unknown>();
	for (const b of offered)
		args.set(JSON.stringify(b.properties.args), b.properties.args);
	return compactUnions(
		JSON.parse(
			JSON.stringify({
				type: "object",
				properties: {
					part: {
						type: "string",
						enum: offered.map((b) => b.properties.part.const),
					},
					args: { anyOf: [...args.values()] },
				},
				required: ["part", "args"],
				additionalProperties: false,
			}),
		),
	);
}

/** The schema of every part; a fresh copy each time, so a host cannot change a shared one. */
export const partCallJsonSchema = (parts?: readonly string[]) =>
	partCallJsonSchemaFor(parts);
