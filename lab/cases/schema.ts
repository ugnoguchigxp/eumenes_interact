import { allowedOriginSchema, originAllowed } from "eumenes-interact";
import { z } from "zod";

/**
 * Case definitions (plan.md §10.2). Everything under `lab/cases` and `lab/scorer` holds expected
 * values: the host must never hand any of it to the core, the model or the adapters (see README.md).
 */

export const SPLITS = ["dev", "holdout", "live"] as const;
export const CATEGORIES = [
	"search",
	"select",
	"form",
	"update",
	"tab",
	"approval",
	"ambiguous",
	"screenshot",
	"read",
	"live",
] as const;
export const VARIANTS = [
	"base",
	"restructure",
	"relabel",
	"duplicate",
	"delayed",
	"stale",
	"live",
] as const;

/** Capture ranges of `page.capture` (plan.md §6.4). */
export const CAPTURE_RANGES = ["viewport", "full", "item"] as const;
export type CaptureRange = (typeof CAPTURE_RANGES)[number];

/** A path inside `lab/fixtures`, as in `sites/<site>/<variant>/<page>.html`. No query, no traversal. */
const fixturePath = z
	.string()
	.regex(/^sites\/[a-z0-9-]+\/[a-z0-9-]+\/[A-Za-z0-9._-]+\.html$/);

/** A fixture start target: a fixture path, optionally with a query string. */
const fixtureStart =
	/^sites\/[a-z0-9-]+\/[a-z0-9-]+\/[A-Za-z0-9._-]+\.html(\?[^#]*)?$/;

/** A live start target: an absolute https URL. */
const liveStart = /^https:\/\/[^\s/?#@]+(\/[^\s#]*)?$/;

/** A path on the start origin of a live case (`/watch`); evaluated against the start origin as base. */
const livePath = /^\/[^?#\s]*$/;

/**
 * Matches a URL the browser was on. `path` must be equal (a fixture path for dev/holdout, an absolute path
 * such as `/watch` for live); every `query` entry must be present with an equal value (NFKC, trimmed; extra
 * parameters are allowed); every `queryPresent` key must exist with any value (a live page whose id is not
 * known in advance, like `/watch?v=<id>`); `hash` (without `#`) must be equal when set.
 */
export const urlPredicateSchema = z.strictObject({
	path: z.union([fixturePath, z.string().regex(livePath)]),
	query: z.record(z.string(), z.string()).optional(),
	queryPresent: z.array(z.string().min(1)).min(1).optional(),
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
		/**
		 * Screenshot requests: at least `min` saved captures (of `range` when given), each a valid PNG/JPEG
		 * under the run's capture folder whose header size matches what the host recorded. What the image
		 * shows is not judged here (plan.md §6.4: recognition is measured on the Eumenes side).
		 */
		captures: z
			.strictObject({
				min: z.int().positive(),
				/** The range asked for; several when the request allows any of them (a "page" may be the view or all of it). */
				range: z
					.union([
						z.enum(CAPTURE_RANGES),
						z.array(z.enum(CAPTURE_RANGES)).min(1),
					])
					.optional(),
				/**
				 * An element capture must be of this element (role and accessible name). The transcript holds only a
				 * digest of the name, so a capture of a neighbouring element does not count.
				 */
				target: z
					.strictObject({ role: z.string().min(1), name: z.string().min(1) })
					.optional(),
				/**
				 * What the captured block must hold (`includes`) and must not (`excludes`), by role and accessible name
				 * (F11). The host reports a block's content as digests; a capture counts only when every wanted
				 * element is among them and no unwanted one is.
				 */
				holds: z
					.strictObject({
						includes: z
							.array(
								z.strictObject({
									role: z.string().min(1),
									name: z.string().min(1),
								}),
							)
							.default([]),
						excludes: z
							.array(
								z.strictObject({
									role: z.string().min(1),
									name: z.string().min(1),
								}),
							)
							.default([]),
					})
					.optional(),
			})
			.optional(),
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
		/** Dev/holdout: a fixture-relative path. Live: an absolute https URL. */
		start: z.string().min(1),
		/**
		 * Live only: the origins (https) the run may visit, exact or `https://*.domain` for a domain and its subdomains; the start origin must be allowed by them. The
		 * host's URL policy and the scorer's scope check both use it.
		 */
		allowedOrigins: z.array(z.string().min(1)).min(1).optional(),
		/** Fixture page the stored site knowledge was taken from (stale-knowledge cases). */
		staleFrom: fixturePath.optional(),
		/** One browser task gets at most 10 model calls (v3 §M4c, MAX_MODEL_CALLS), so no case may ask for more. */
		budget: z.strictObject({ maxModelCalls: z.int().positive().max(10) }),
		/** What the scripted user answers when the host asks for approval of an effectful operation. */
		approvalScript: z.strictObject({
			decision: z.enum(["grant", "deny"]),
			/** Why this answer is given. A live case that grants must say the user authorized the scenario. */
			note: z.string().min(1).optional(),
		}),
		expect: expectSchema,
	})
	.superRefine((c, ctx) => {
		const live = c.split === "live";
		const issue = (path: (string | number)[], message: string) =>
			ctx.addIssue({ code: "custom", path, message });
		if (live) {
			if (!liveStart.test(c.start))
				issue(["start"], "a live start is an absolute https URL");
			if (!c.allowedOrigins)
				issue(["allowedOrigins"], "a live case needs allowedOrigins");
			else {
				const bad = c.allowedOrigins.some(
					(o) => !allowedOriginSchema.safeParse(o).success,
				);
				if (bad)
					issue(
						["allowedOrigins"],
						"https origins only, without a path (https://*.domain allows its subdomains)",
					);
				else if (
					liveStart.test(c.start) &&
					!originAllowed(c.allowedOrigins, new URL(c.start).origin)
				)
					issue(["allowedOrigins"], "must allow the start origin");
			}
			if (c.approvalScript.decision === "grant" && !c.approvalScript.note)
				issue(
					["approvalScript", "note"],
					"a live grant needs a note saying the user authorized the scenario",
				);
			if (c.staleFrom !== undefined)
				issue(["staleFrom"], "staleFrom is for fixtures");
		} else {
			if (!fixtureStart.test(c.start))
				issue(["start"], "a fixture start is a path under sites/");
			if (c.allowedOrigins !== undefined)
				issue(["allowedOrigins"], "allowedOrigins is for live cases only");
		}
		const predicatePaths = [
			...c.expect.effectful,
			...c.expect.forbidden,
			...c.expect.wrongTargets,
			...(c.expect.kind === "reach" ? c.expect.final : []),
		].map((p) => p.path);
		for (const path of predicatePaths)
			if (path.startsWith("/") !== live)
				issue(
					["expect"],
					live
						? "live predicates use absolute paths like /watch"
						: "fixture predicates use fixture paths",
				);
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
