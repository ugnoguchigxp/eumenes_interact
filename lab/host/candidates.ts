import type { Database } from "bun:sqlite";
import {
	findSiteObjects,
	listPageProfiles,
	type CandidateRecord,
	type PageProfile,
	type SiteObjectView,
} from "eumenes-interact/sqlite";
import { normalize, parseAria, type AriaNode } from "../aria.ts";

/**
 * Site knowledge against the page in front of the browser (plan.md §7.3): which page profile the URL is
 * on, whether an object is defined for it, and which element of the current observation a candidate
 * names. Deterministic and read-only. A stored candidate is a claim, never a locator: it must find exactly
 * one element (or the one the candidate's own `nth` picks) in this very observation, else the step stops.
 */

export type Match = { ref: string; role: string; name: string | null };

export type CandidateResolution =
	| { kind: "found"; match: Match }
	| { kind: "none" | "ambiguous" | "unsupported" };

type Fields = Readonly<Record<string, string | number | boolean>>;

const text = (fields: Fields, key: string): string | undefined => {
	const value = fields[key];
	return typeof value === "string" ? value : undefined;
};

/** `a|b` as a list of normalised alternatives. */
const alternatives = (value: string) =>
	value
		.split("|")
		.map(normalize)
		.filter((item) => item !== "");

const isTrue = (value: string | number | boolean | undefined) =>
	value === true || value === "true";

/** The link text as written and as a person would read it (`%E7%89%B9…` is `特…`). */
function urlVariants(url: string): string[] {
	try {
		return [url, decodeURIComponent(url)];
	} catch {
		return [url];
	}
}

const hasAny = (url: string, needles: readonly string[]) =>
	urlVariants(url).some((v) => needles.some((n) => v.includes(n)));

/** One candidate against the whole observation body. */
export function resolveCandidate(
	body: string,
	candidate: Pick<CandidateRecord, "kind" | "fields">,
): CandidateResolution {
	if (candidate.kind !== "role" && candidate.kind !== "structure")
		return { kind: "unsupported" };
	const { fields } = candidate;
	const role = text(fields, "role");
	if (role === undefined) return { kind: "unsupported" };
	const name = text(fields, "name");
	const anyOf = text(fields, "nameAnyOf");
	const names =
		name !== undefined
			? [normalize(name)]
			: anyOf !== undefined
				? alternatives(anyOf)
				: null;
	const include = text(fields, "urlIncludes");
	const exclude = text(fields, "urlExcludes");
	const within = text(fields, "withinRole");
	const named = isTrue(fields["named"]);
	const hits = parseAria(body).filter(
		(n: AriaNode) =>
			n.ref !== null &&
			n.role === role &&
			(names === null || (n.name !== null && names.includes(n.name))) &&
			(!named || (n.name !== null && n.name !== "")) &&
			(include === undefined || (n.url !== null && hasAny(n.url, [include]))) &&
			(exclude === undefined ||
				n.url === null ||
				!hasAny(n.url, alternatives(exclude))) &&
			(within === undefined || n.parents.some((p) => p.role === within)),
	);
	const nth = fields["nth"] === undefined ? null : Number(fields["nth"]);
	if (nth !== null && (!Number.isInteger(nth) || nth < 0))
		return { kind: "unsupported" };
	const pick = nth === null ? hits[0] : hits[nth];
	if (!pick) return { kind: "none" };
	if (nth === null && hits.length > 1) return { kind: "ambiguous" };
	return {
		kind: "found",
		match: { ref: pick.ref!, role: pick.role, name: pick.name },
	};
}

export type ObjectResolution =
	| {
			kind: "found";
			match: Match;
			/** The candidates that found this element (evidence is recorded for each). */
			candidateIds: number[];
	  }
	| { kind: "none" | "ambiguous" | "unsupported" };

/**
 * An object's usable candidates (`candidate` or `verified`; a stale or disabled one is not tried) against the
 * observation. They are a set, not a fallback chain: they must agree on one element.
 */
export function resolveObject(
	body: string,
	candidates: readonly CandidateRecord[],
): ObjectResolution {
	const usable = candidates.filter(
		(c) => c.status === "candidate" || c.status === "verified",
	);
	const results = usable.map((c) => ({ c, r: resolveCandidate(body, c) }));
	const found = results.flatMap(({ c, r }) =>
		r.kind === "found" ? [{ c, match: r.match }] : [],
	);
	const refs = new Set(found.map((f) => f.match.ref));
	if (refs.size === 1)
		return {
			kind: "found",
			match: found[0]!.match,
			candidateIds: found.map((f) => f.c.id),
		};
	if (refs.size > 1) return { kind: "ambiguous" };
	if (results.some(({ r }) => r.kind === "ambiguous"))
		return { kind: "ambiguous" };
	if (results.length > 0 && results.every(({ r }) => r.kind === "unsupported"))
		return { kind: "unsupported" };
	return { kind: "none" };
}

/**
 * The profiles whose `urlHint` is a prefix of the page's path, longest first (`/` matches every page, so it
 * is the last resort). A profile without a hint never matches by URL.
 */
export function profileChain(
	profiles: readonly PageProfile[],
	pageUrl: string,
): PageProfile[] {
	let path: string;
	try {
		path = new URL(pageUrl).pathname;
	} catch {
		return [];
	}
	return profiles
		.filter((p) => p.urlHint !== null && path.startsWith(p.urlHint))
		.sort(
			(a, b) =>
				b.urlHint!.length - a.urlHint!.length || (a.name < b.name ? -1 : 1),
		);
}

export type Lookup =
	| { kind: "defined"; profile: string; object: SiteObjectView }
	| { kind: "undefined"; profile: string | null };

/**
 * Whether `logicalName` is defined for the page at `pageUrl`: in the profile the longest prefix selects, or
 * else in a shorter one that also matches (an object of `/` is known on every page of the site). A site
 * without knowledge, or an object defined only for other kinds of page, is `undefined`.
 */
export function lookupObject(
	db: Database,
	owner: string,
	pageUrl: string,
	logicalName: string,
): Lookup {
	let origin: string;
	try {
		origin = new URL(pageUrl).origin;
	} catch {
		return { kind: "undefined", profile: null };
	}
	const chain = profileChain(listPageProfiles(db, owner, origin), pageUrl);
	for (const profile of chain) {
		const [object] = findSiteObjects(db, owner, {
			origin,
			profile: profile.name,
			logicalName,
		});
		if (object) return { kind: "defined", profile: profile.name, object };
	}
	return { kind: "undefined", profile: chain[0]?.name ?? null };
}
