import type { InteractDb } from "../contracts/db.ts";
import { parseUrl } from "../core/shared/text.ts";
import { assertWritable, changedRows, guarded } from "./db.ts";
import { InteractStoreError } from "./errors.ts";
import {
	invalid,
	isStorableOrigin,
	requireOrigin,
	requireText,
	requireTimestamp,
	requireInteger,
} from "./validate.ts";
import { getSiteScope, upsertSiteScope } from "./site-knowledge.ts";

export type SearchTemplate = {
	origin: string;
	pathPrefix: string;
	template: string;
	revision: number;
	sourceRef: string;
	checkedAt: string;
	expiresAt: string;
};
/** External URL format data, addressed by owner and origin, never a user-intent dictionary. */
export function putSearchTemplate(
	db: InteractDb,
	owner: string,
	input: SearchTemplate,
) {
	assertWritable(db);
	requireOrigin(input.origin);
	requireText(input.sourceRef, "sourceRef", 1000);
	requireInteger(input.revision, "revision", 1);
	requireTimestamp(input.checkedAt, "checkedAt");
	requireTimestamp(input.expiresAt, "expiresAt");
	if (
		input.expiresAt <= input.checkedAt ||
		!input.pathPrefix.startsWith("/") ||
		input.pathPrefix.length > 256 ||
		/[?#]/.test(input.pathPrefix) ||
		input.template.split("{q}").length !== 2 ||
		input.template.length > 2000
	)
		throw invalid("template");
	let url: ReturnType<typeof parseUrl>;
	try {
		url = parseUrl(input.template.replace("{q}", "probe"));
	} catch {
		throw invalid("template");
	}
	if (
		url.origin !== input.origin ||
		url.protocol !== "https:" ||
		url.username ||
		url.password
	)
		throw invalid("template");
	const scope = upsertSiteScope(db, owner, input.origin, input.checkedAt);
	const previous = db
		.query(
			"SELECT template,revision,source_ref,checked_at,expires_at FROM interact_site_search_templates WHERE scope_id=? AND path_prefix=?",
		)
		.get(scope.id, input.pathPrefix) as {
		template: string;
		revision: number;
		source_ref: string;
		checked_at: string;
		expires_at: string;
	} | null;
	if (
		previous?.revision === input.revision &&
		(previous.template !== input.template ||
			previous.source_ref !== input.sourceRef ||
			previous.checked_at !== input.checkedAt ||
			previous.expires_at !== input.expiresAt)
	)
		throw new InteractStoreError("revision_conflict", "searchTemplate");
	// The upsert only replaces a strictly older revision. Writing the same revision with the same
	// content again is a harmless repeat (checked above); any other no-op means a newer revision is
	// stored, and reporting success would let the caller believe its template is in use.
	const repeat = previous?.revision === input.revision;
	guarded(() => {
		db.query(
			`INSERT INTO interact_site_search_templates VALUES(?,?,?,?,?,?,?)
	 ON CONFLICT(scope_id,path_prefix) DO UPDATE SET template=excluded.template,revision=excluded.revision,source_ref=excluded.source_ref,checked_at=excluded.checked_at,expires_at=excluded.expires_at
	 WHERE excluded.revision > interact_site_search_templates.revision`,
		).run(
			scope.id,
			input.pathPrefix,
			input.template,
			input.revision,
			input.sourceRef,
			input.checkedAt,
			input.expiresAt,
		);
		if (changedRows(db) !== 1 && !repeat) {
			throw new InteractStoreError("stale_revision", "searchTemplate");
		}
	});
}

/** Most specific applicable path. Expiry and revision are host data; URLs still need the execution gate. */
export function getSearchUrl(
	db: InteractDb,
	owner: string,
	pageUrl: string,
	query: string,
	nowIso: string,
): string | null {
	requireTimestamp(nowIso, "nowIso");
	let url: ReturnType<typeof parseUrl>;
	try {
		url = parseUrl(pageUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	// A page whose origin the store cannot hold (WHATWG allows `my_host.example`; the store's form does not) has
	// no template: a lookup answers null rather than failing the part that asked (design R10).
	if (!isStorableOrigin(url.origin)) return null;
	const scope = getSiteScope(db, owner, url.origin);
	if (!scope) return null;
	const rows = db
		.query(
			"SELECT path_prefix,template FROM interact_site_search_templates WHERE scope_id=? AND expires_at>? ORDER BY length(path_prefix) DESC",
		)
		.all(scope.id, nowIso) as { path_prefix: string; template: string }[];
	const row = rows.find(
		(r) =>
			r.path_prefix === "/" ||
			url.pathname === r.path_prefix ||
			url.pathname.startsWith(r.path_prefix.replace(/\/$/, "") + "/"),
	);
	return row ? row.template.replace("{q}", encodeURIComponent(query)) : null;
}
