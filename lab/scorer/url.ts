import type { UrlPredicate } from "../cases/schema.ts";

/** A browser URL resolved against the fixture root. */
export type FixtureRef = { path: string; query: URLSearchParams; hash: string };

/** `null` when the URL is not inside the fixture root (or is not a URL at all). */
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
	if (p.path !== ref.path) return false;
	if (p.hash !== undefined && p.hash !== ref.hash) return false;
	return Object.entries(p.query ?? {}).every(([key, expected]) => {
		const actual = ref.query.get(key);
		return actual !== null && normalize(actual) === normalize(expected);
	});
}

export const matchesAny = (
	predicates: readonly UrlPredicate[],
	ref: FixtureRef,
): boolean => predicates.some((p) => matchesPredicate(p, ref));
