import { z } from "zod";

/**
 * Work definitions (plan.md §6): versioned JSON that names published operations, the logical site
 * objects they act on, and the inputs that change per run. No expressions, loops or conditions: a value
 * is a literal or `{ "$input": "<name>" }`, resolved only from inputs checked against `inputs`.
 * A published revision is immutable; a change is a new revision.
 *
 * The functions implementing `DefinitionApi` live in `src/definitions/` and are re-exported from the root.
 */

const NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const LOGICAL_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
/**
 * An allowed origin: `https://host[:port]`, or `https://*.domain` for the domain itself and every
 * subdomain of it (https, default port).
 */
const ORIGIN_PATTERN =
	/^https:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/;

export const inputRefSchema = z.strictObject({
	$input: z.string().regex(NAME),
});
export const definitionValueSchema = z.union([
	z.string().max(2048),
	inputRefSchema,
]);
export const logicalNameSchema = z.string().max(64).regex(LOGICAL_NAME);
export const allowedOriginSchema = z.string().max(256).regex(ORIGIN_PATTERN);

const inputPropertySchema = z.strictObject({
	type: z.literal("string"),
	minLength: z.number().int().min(0).max(2048).optional(),
	maxLength: z.number().int().min(1).max(2048).optional(),
	description: z.string().max(200).optional(),
});
export const definitionInputsSchema = z.strictObject({
	type: z.literal("object"),
	properties: z.record(z.string().regex(NAME), inputPropertySchema),
	required: z.array(z.string().regex(NAME)),
	additionalProperties: z.literal(false),
});

const stepBase = {
	id: z.string().regex(STEP_ID),
	/** What must be observable after the step; judged against the observation, never auto-converted to code. */
	expectation: z.string().min(1).max(300),
	/**
	 * The step is skipped when its `targetObject` is not defined for the page profile the browser is on
	 * (e.g. a search that jumps straight to the article). Never skips a step whose target is defined but
	 * missing or ambiguous on the page: that stops the run.
	 */
	optional: z.boolean().optional(),
};

export const definitionStepSchema = z.discriminatedUnion("action", [
	z.strictObject({
		...stepBase,
		action: z.literal("browser.navigate"),
		args: z.strictObject({ url: definitionValueSchema }),
	}),
	z.strictObject({
		...stepBase,
		action: z.literal("page.fill"),
		targetObject: logicalNameSchema,
		args: z.strictObject({
			value: definitionValueSchema,
			submit: z.boolean(),
		}),
	}),
	z.strictObject({
		...stepBase,
		action: z.literal("page.click"),
		targetObject: logicalNameSchema,
	}),
	z.strictObject({
		...stepBase,
		action: z.literal("page.press"),
		args: z.strictObject({ key: z.string().min(1).max(32) }),
	}),
	z.strictObject({
		...stepBase,
		action: z.literal("page.wait"),
		args: z.strictObject({ seconds: z.number().min(0.1).max(30) }),
	}),
	z.strictObject({
		...stepBase,
		action: z.literal("page.observe"),
	}),
	z.strictObject({
		...stepBase,
		action: z.literal("page.extract"),
		/** The content root (e.g. `article.body`); absent uses the adapter's generic order. */
		targetObject: logicalNameSchema.optional(),
		args: z.strictObject({
			maxChars: z.number().int().min(100).max(50000),
		}),
	}),
]);

export const workDefinitionSchema = z.strictObject({
	formatVersion: z.literal(1),
	id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	revision: z.number().int().min(1),
	title: z.string().min(1).max(120),
	skillRef: z.string().regex(/^skill:[a-z][a-z0-9.-]*@\d+$/),
	catalogRef: z.string().regex(/^catalog:[a-z][a-z0-9.-]*@\d+$/),
	/** Every page the run may visit; checked by the host before sending and after loading. */
	allowedOrigins: z.array(allowedOriginSchema).min(1).max(16),
	inputs: definitionInputsSchema,
	steps: z.array(definitionStepSchema).min(1).max(32),
});

export type WorkDefinition = z.infer<typeof workDefinitionSchema>;
export type DefinitionStep = z.infer<typeof definitionStepSchema>;
export type DefinitionAction = DefinitionStep["action"];

/** A step with every `$input` replaced by the checked input string. */
export type ResolvedStep = DefinitionStep extends infer S
	? S extends { args: infer A }
		? Omit<S, "args"> & {
				args: {
					[K in keyof A]: A[K] extends string | { $input: string }
						? string
						: A[K];
				};
			}
		: S
	: never;

/** Where a definition or its inputs break the rules; never carries an input value. */
export type DefinitionIssue = { path: string; code: string };

export type DefinitionApi = {
	/** Schema plus semantic checks (unique step ids, declared `$input`s, navigate URLs inside `allowedOrigins`…). */
	parseDefinition(
		value: unknown,
	):
		| { ok: true; definition: WorkDefinition }
		| { ok: false; issues: DefinitionIssue[] };
	/** Checks `inputs` against the definition's input schema and resolves every `$input`. */
	resolveDefinition(
		definition: WorkDefinition,
		inputs: Readonly<Record<string, unknown>>,
	):
		| { ok: true; steps: ResolvedStep[] }
		| { ok: false; issues: DefinitionIssue[] };
	/** sha256 (hex) of the definition's canonical JSON (sorted keys); pure, no platform crypto. */
	definitionDigest(definition: WorkDefinition): string;
	/** `true` when `origin` (`scheme://host[:port]`, lowercase) is allowed by the patterns. */
	originAllowed(allowedOrigins: readonly string[], origin: string): boolean;
	/** The public JSON Schema of a work definition, generated from the zod schema. */
	definitionJsonSchema(): Record<string, unknown>;
};
