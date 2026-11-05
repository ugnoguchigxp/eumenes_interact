import type { Database } from "bun:sqlite";
import { getSearchUrl, putSearchTemplate } from "eumenes-interact/sqlite";
import catalog from "../config/site-searches.json" with { type: "json" };
import { write } from "./db.ts";

/** Versioned observed hints enter the same owner-scoped SQLite knowledge store as other site data. */
export function siteSearchUrl(
	db: Database,
	owner: string,
	pageUrl: string,
	query: string,
	nowIso: string,
): string | null {
	let origin: string;
	try {
		origin = new URL(pageUrl).origin;
	} catch {
		return null;
	}
	const hints = catalog.entries.filter(
		(e) => e.origin === origin && e.expiresAt > nowIso,
	);
	if (hints.length)
		write(db, () => {
			for (const entry of hints) putSearchTemplate(db, owner, entry);
		});
	return getSearchUrl(db, owner, pageUrl, query, nowIso);
}
