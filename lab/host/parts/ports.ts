import type { Database } from "bun:sqlite";
import type { PartEventsPort, SiteKnowledgePort } from "eumenes-interact";
import { lookupObject, resolveObject } from "../candidates.ts";
import type { LabLogger } from "../log.ts";
import { siteSearchUrl } from "../site-searches.ts";

/** The lab's implementations of the part capability's ports (its SQLite site knowledge and its logger). */
export function labKnowledgePort(
	db: Database,
	owner: string,
): SiteKnowledgePort {
	return {
		searchUrl: (url, query) =>
			siteSearchUrl(db, owner, url, query, new Date().toISOString()),
		resolve(pageUrl, body, logicalName) {
			const known = lookupObject(db, owner, pageUrl, logicalName);
			if (known.kind !== "defined") return null;
			const found = resolveObject(body, known.object.candidates);
			if (found.kind !== "found") return null;
			return {
				ref: found.match.ref,
				role: found.match.role,
				name: found.match.name ?? "",
			};
		},
	};
}

export function labEventsPort(
	logger: LabLogger,
	runId: string,
): PartEventsPort {
	return {
		event(name, fields) {
			logger.lab(name, {
				correlationId: runId,
				...(fields.code === undefined ? {} : { code: fields.code }),
			});
		},
	};
}
