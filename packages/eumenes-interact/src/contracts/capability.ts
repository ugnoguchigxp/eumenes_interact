import type { PartStatus } from "./parts.ts";

/**
 * Ports the browser-part capability is given by its host (dependency injection). The capability itself owns no
 * recorder, logger or database: the lab, the MCP server or the collaboration host each supply their own.
 */

/** What one saved capture is recorded as (never the image or the path). */
export type CaptureSavedRecord = {
	captureId: string;
	fileName: string;
	width: number;
	height: number;
	bytes: number;
	mediaType: "image/png" | "image/jpeg";
	range: "viewport" | "full" | "item";
	target?: { role: string; nameHash: string };
};

/** The run's transcript: part names and argument names only, never values. */
export type PartRecordPort = {
	partCall(part: string, args: readonly string[]): void;
	partResult(part: string, status: PartStatus, code?: string): void;
	captureSaved(saved: CaptureSavedRecord): void;
};

/** Operational events (no page content). */
export type PartEventsPort = {
	event(
		name: "capture.saved" | "part.executed",
		fields: { code?: string },
	): void;
};

/** A known element resolved in the current observation from site knowledge. */
export type KnownElement = { ref: string; role: string; name: string };

/** Site knowledge: resolves a logical name such as `search.query` on a page, or null when unknown. */
export type SiteKnowledgePort = {
	resolve(
		pageUrl: string,
		body: string,
		logicalName: string,
	): KnownElement | null;
};
