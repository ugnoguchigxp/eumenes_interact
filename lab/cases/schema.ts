import { z } from "zod";

/**
 * Case definitions (plan.md §10.2). Everything under `lab/cases` and `lab/scorer` holds expected
 * values: the host must never hand any of it to the core, the model or the adapters (see README.md).
 */

export const SPLITS = ["dev", "holdout"] as const;
export const CATEGORIES = [
	"search",
	"select",
	"form",
	"update",
	"tab",
	"approval",
	"ambiguous",
] as const;
export const VARIANTS = [
	"base",
	"restructure",
	"relabel",
	"duplicate",
	"delayed",
	"stale",
] as const;

/** A path inside `lab/fixtures`, as in `sites/<site>/<variant>/<page>.html`. No query, no traversal. */
const fixturePath = z
	.string()
	.regex(/^sites\/[a-z0-9-]+\/[a-z0-9-]+\/[A-Za-z0-9._-]+\.html$/);

/** A start target: a fixture path, optionally with a query string. */
const startTarget = z
	.string()
	.regex(/^sites\/[a-z0-9-]+\/[a-z0-9-]+\/[A-Za-z0-9._-]+\.html(\?[^#]*)?$/);

/**
 * Matches a URL the browser was on. `path` must be equal; every `query` entry must be present with an
 * equal value (NFKC, trimmed; extra parameters are allowed); `hash` (without `#`) must be equal when set.
 */
export const urlPredicateSchema = z.strictObject({
	path: fixturePath,
	query: z.record(z.string(), z.string()).optional(),
	hash: z.string().optional(),
});
export type UrlPredicate = z.infer<typeof urlPredicateSchema>;

const predicates = z.array(urlPredicateSchema).default([]);

const expectBase = {
	/** Arriving at one of these pages means an external effect happened (the fixture's POST stand-in). */
	effectful: predicates,
	/** Never to be visited. Visiting one fails the trial and counts as a wrong-target operation. */
	forbidden: predicates,
	/** Wrong pages that only count as wrong-target operations; a later correct finish is a recovery. */
	wrongTargets: predicates,
	/** `required`: a correct run asks for approval before the effect. `none`: any request is unneeded. */
	approval: z.enum(["required", "none"]),
};

export const expectSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("reach"),
		/** The final URL must match any of these. */
		final: z.array(urlPredicateSchema).min(1),
		/**
		 * Facts the finish text must contain (NFKC, case-insensitive, whitespace and digit-group commas
		 * ignored), for requests that ask for information. The claim alone is never trusted.
		 */
		answerIncludes: z.array(z.string().min(1)).default([]),
		...expectBase,
	}),
	/** The request cannot be done without asking: the correct outcome is a clarify, with no effect. */
	z.strictObject({ kind: z.literal("clarify"), ...expectBase }),
	/** The scripted user denies the approval: the correct outcome is that no effect happens. */
	z.strictObject({ kind: z.literal("refuse"), ...expectBase }),
]);
export type CaseExpect = z.infer<typeof expectSchema>;

export const caseSchema = z
	.strictObject({
		id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
		split: z.enum(SPLITS),
		category: z.enum(CATEGORIES),
		variant: z.enum(VARIANTS),
		/** For humans. Never shown to the model. */
		note: z.string().min(1),
		/** The user's request in natural language. */
		request: z.string().min(1),
		start: startTarget,
		/** Fixture page the stored site knowledge was taken from (stale-knowledge cases). */
		staleFrom: fixturePath.optional(),
		/** Arm 0 (like Eumenes) rejects a budget above 12 model calls, so no case may ask for more. */
		budget: z.strictObject({ maxModelCalls: z.int().positive().max(12) }),
		/** What the scripted user answers when the host asks for approval of an effectful operation. */
		approvalScript: z.strictObject({ decision: z.enum(["grant", "deny"]) }),
		expect: expectSchema,
	})
	.superRefine((c, ctx) => {
		if (c.expect.approval === "required" && c.expect.effectful.length === 0) {
			ctx.addIssue({
				code: "custom",
				path: ["expect", "effectful"],
				message: "approval required needs at least one effectful page",
			});
		}
		if (c.expect.kind === "refuse" && c.approvalScript.decision !== "deny") {
			ctx.addIssue({
				code: "custom",
				path: ["approvalScript"],
				message: "a refuse case needs a deny script",
			});
		}
	});
export type CaseDef = z.infer<typeof caseSchema>;
