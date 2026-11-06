import type { Database } from "bun:sqlite";
import {
	findSiteObjects,
	isStorableOrigin,
	listPageProfiles,
	type CandidateRecord,
	type PageProfile,
	type SiteObjectView,
} from "eumenes-interact/sqlite";
import {
	resolveCandidate,
	type SnapshotCandidateResolution,
	type SnapshotMatch,
} from "eumenes-interact";

export { resolveCandidate };

/**
 * Site knowledge against the page in front of the browser (plan.md §7.3): which page profile the URL is
 * on, whether an object is defined for it, and which element of the current observation a candidate
 * names. Deterministic and read-only. A stored candidate is a claim, never a locator: it must find exactly
 * one element (or the one the candidate's own `nth` picks) in this very observation, else the step stops.
 * Matching itself is `resolveCandidate` in the package, on the same snapshot tree the parts read.
 */

export type Match = SnapshotMatch;

export type CandidateResolution = SnapshotCandidateResolution;

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
	// An origin the store cannot hold (`my_host.example`) has no knowledge; the lookup must not fail the part.
	if (!isStorableOrigin(origin)) return { kind: "undefined", profile: null };
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
