import { z } from "zod";
import { partCallSchema } from "../../contracts/parts.ts";

/**
 * The structured-output JSON Schema of a part call: what Claude's `output_config.format` accepts. Objects stay
 * closed (`additionalProperties: false`), a union is `anyOf`, and the keywords the API does not support
 * (string, number and array constraints, `pattern`) are left out; zod still checks every one of them in
 * `parseStep`. The schema has no `$ref`, so nothing is recursive.
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
	if (out.type === "object" && out.required === undefined) out.required = [];
	return out;
}

type Branch = { properties: { part: { const: string }; args: unknown } };
const branches = (
	sanitize(z.toJSONSchema(partCallSchema)) as { anyOf: Branch[] }
).anyOf;

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
	return JSON.parse(
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
	);
}

/** The schema of every part; a fresh copy each time, so a host cannot change a shared one. */
export const partCallJsonSchema = () => partCallJsonSchemaFor();
