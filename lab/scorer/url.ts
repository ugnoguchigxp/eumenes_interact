import type { UrlPredicate } from "../cases/schema.ts";

/** A browser URL resolved against the trial's base URL (the fixture server's, or a live case's start origin). */
export type FixtureRef = { path: string; query: URLSearchParams; hash: string };

/** `null` when the URL is not inside the base (same origin and path prefix), or is not a URL at all. */
export function toFixtureRef(url: string, baseUrl: string): FixtureRef | null {
	try {
		const u = new URL(url);
		const base = new URL(baseUrl);
		if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) {
			return null;
		}
		return {
			path: decodeURIComponent(u.pathname.slice(base.pathname.length)),
			query: u.searchParams,
			hash: decodeURIComponent(u.hash.slice(1)),
		};
	} catch {
		return null;
	}
}

/** NFKC, trimmed, whitespace collapsed: values are compared as a person would read them. */
const normalize = (s: string): string =>
	s.normalize("NFKC").trim().replace(/\s+/g, " ");

export function matchesPredicate(p: UrlPredicate, ref: FixtureRef): boolean {
	// Fixture paths have no leading slash, live paths do (`/watch`): the same page either way.
	if (p.path.replace(/^\//, "") !== ref.path) return false;
	if (p.hash !== undefined && p.hash !== ref.hash) return false;
	if ((p.queryPresent ?? []).some((key) => !ref.query.has(key))) return false;
	return Object.entries(p.query ?? {}).every(([key, expected]) => {
		const actual = ref.query.get(key);
		return actual !== null && normalize(actual) === normalize(expected);
	});
}

export const matchesAny = (
	predicates: readonly UrlPredicate[],
	ref: FixtureRef,
): boolean => predicates.some((p) => matchesPredicate(p, ref));
