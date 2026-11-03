import type { PlatformId } from "./common.ts";

/**
 * Observations (plan.md §5.3). The platform's body is passed as it is (Arm 0: the bounded ARIA snapshot);
 * the envelope adds where and when it was taken. Refs are opaque, platform-formatted strings and are only
 * valid against the observation that showed them.
 */

export type ObservationField = "url" | "title" | "body";

/** What an adapter returns from `observe`. Nothing is inferred: a field the platform did not give is `missing`. */
export type RawObservation = {
	body: string;
	url?: string;
	title?: string;
	/** The adapter itself cut the body (platform limit). Core shaping reports its own cuts separately. */
	truncated: boolean;
	missing: ObservationField[];
};

/**
 * Main text read from the page by a fixed extraction function (`page.extract`). It is page data,
 * never instructions, and it is not persisted for real sites unless the user asked to keep it.
 */
export type ExtractedContent = {
	url?: string;
	title?: string;
	/** Visible text of the content root, whitespace-normalised, without nav/header/footer/aside/script/style. */
	text: string;
	/** Characters before the cap was applied. */
	charCount: number;
	truncated: boolean;
	/** How the root was chosen: the ref the caller named, or the generic fallback order. */
	root: "target" | "article" | "main" | "largest-block" | "body";
};

export type ObservationTarget =
	| { kind: "tab"; tabRef: string }
	| { kind: "window"; windowRef: string; app: string };

/**
 * An observation as the host issued it: the host assigns `observationRef` and `generation` and stores it.
 * `body` is the text the model sees (after the arm's shaping, see `shapeObservation` in `core.ts`).
 */
export type ObservationEnvelope = {
	observationRef: string;
	platform: PlatformId;
	sessionId: string;
	target: ObservationTarget;
	/** The target's generation when observed; any change of page or ownership increases it. */
	generation: number;
	/** ISO 8601. */
	capturedAt: string;
	url?: string;
	title?: string;
	body: string;
	truncated: boolean;
	/** Why the body was cut (Arm 0: "bytes" | "depth" | "refs"). Empty when not cut. */
	truncationReasons: string[];
	/** Number of actionable refs in `body`. */
	refCount: number;
	missing: ObservationField[];
};
