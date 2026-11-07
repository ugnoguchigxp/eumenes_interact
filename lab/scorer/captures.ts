import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CaptureRange } from "../cases/schema.ts";
import type { TranscriptEvent } from "./transcript.ts";

export type CaptureEvent = Extract<TranscriptEvent, { type: "capture.saved" }>;

type ImageHeader = {
	mediaType: "image/png" | "image/jpeg";
	width: number;
	height: number;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The type and size an image file declares, read from its magic bytes; null when it is neither PNG nor JPEG. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		bytes.length >= 24 &&
		PNG_SIGNATURE.every((b, i) => bytes[i] === b) &&
		view.getUint32(8) === 13 &&
		view.getUint32(12) === 0x49484452
	) {
		return {
			mediaType: "image/png",
			width: view.getUint32(16),
			height: view.getUint32(20),
		};
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let at = 2;
		while (at + 4 <= bytes.length) {
			if (bytes[at] !== 0xff) return null;
			const marker = bytes[at + 1] as number;
			if (marker === 0xff) {
				at++;
				continue;
			}
			// Standalone markers carry no length.
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
				at += 2;
				continue;
			}
			const length = view.getUint16(at + 2);
			const isFrame =
				marker >= 0xc0 &&
				marker <= 0xcf &&
				![0xc4, 0xc8, 0xcc].includes(marker);
			if (isFrame) {
				if (at + 9 > bytes.length) return null;
				return {
					mediaType: "image/jpeg",
					height: view.getUint16(at + 5),
					width: view.getUint16(at + 7),
				};
			}
			at += 2 + length;
		}
	}
	return null;
}

/**
 * The digest an element capture's target name is recorded as: what the scorer compares with a case's expected
 * target, without the transcript holding page text.
 */
export { captureTargetHash } from "eumenes-interact/parts";
import { captureTargetHash } from "eumenes-interact/parts";

/** Why a saved capture is not valid; null when it is. */
export function captureProblem(
	event: CaptureEvent,
	captureDir: string | undefined,
): string | null {
	if (captureDir === undefined || !isAbsolute(captureDir)) {
		return "no_capture_dir";
	}
	const { fileName } = event;
	if (
		fileName === "" ||
		fileName.includes("\0") ||
		isAbsolute(fileName) ||
		fileName.split(/[\\/]/).includes("..")
	) {
		return "unsafe_file_name";
	}
	let bytes: Uint8Array;
	try {
		const dir = realpathSync(captureDir);
		const file = realpathSync(resolve(dir, fileName));
		const rel = relative(dir, file);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
			return "outside_capture_dir";
		}
		if (!statSync(file).isFile()) return "not_a_file";
		bytes = readFileSync(file);
	} catch {
		return "missing_file";
	}
	const header = readImageHeader(bytes);
	if (!header) return "not_an_image";
	if (header.mediaType !== event.mediaType) return "media_type_mismatch";
	if (header.width === 0 || header.height === 0) return "empty_image";
	if (header.width !== event.width || header.height !== event.height) {
		return "size_mismatch";
	}
	return null;
}

export type RangeElement = { role: string; name: string };

/** What a capture of one block must hold, and what it must not (F11): by role and name. */
export type RangeExpect = {
	includes?: readonly RangeElement[];
	excludes?: readonly RangeElement[];
};

export type RangeScore = {
	/** Wanted elements the capture does not report holding (or cannot be confirmed to hold). */
	missing: RangeElement[];
	/** Unwanted elements the capture reports holding. */
	extra: RangeElement[];
	/** The list was cut (or absent), so a missing element may only be unconfirmed. */
	unconfirmed: boolean;
	/** All wanted elements are held and no unwanted one is. */
	ok: boolean;
};

/**
 * Whether the block a capture took holds what was asked and not what was not: the second and third of the
 * range measures (the first, that it is the intended block, is the case's `target`). The transcript has only
 * digests, so the expected elements are hashed the same way. A wanted element absent from a cut list counts
 * as missing, as the model could not have confirmed it either.
 */
export function captureRangeScore(
	event: CaptureEvent,
	expect: RangeExpect,
): RangeScore {
	const held = new Set(
		(event.holds ?? []).map((h) => `${h.role}\0${h.nameHash}`),
	);
	const has = (e: RangeElement) =>
		held.has(`${e.role}\0${captureTargetHash(e.name)}`);
	const missing = (expect.includes ?? []).filter((e) => !has(e));
	const extra = (expect.excludes ?? []).filter(has);
	const unconfirmed =
		event.holds === undefined || (event.holdsCount ?? 0) > event.holds.length;
	// A cut list cannot show an excluded element is absent (it may be in the part that was cut): not ok then.
	return {
		missing: [...missing],
		extra: [...extra],
		unconfirmed,
		ok:
			missing.length === 0 &&
			extra.length === 0 &&
			!(unconfirmed && (expect.excludes ?? []).length > 0),
	};
}

export type CaptureCheck = {
	/** Capture events of the requested range (all when no range is asked) and of the expected target, when one is. */
	matching: number;
	/** Capture events, of any range, whose file failed a check. */
	invalid: number;
	wrongRange: number;
	wrongTarget: number;
	contentMismatch: number;
	unconfirmed: number;
};

export function checkCaptures(
	events: readonly CaptureEvent[],
	captureDir: string | undefined,
	range: CaptureRange | readonly CaptureRange[] | undefined,
	target?: { role: string; name: string },
	holds?: RangeExpect,
): CaptureCheck {
	const ranges: readonly CaptureRange[] | undefined =
		range === undefined || Array.isArray(range)
			? range
			: [range as CaptureRange];
	const hash =
		target === undefined ? undefined : captureTargetHash(target.name);
	const rangeMatches = (e: CaptureEvent) =>
		ranges === undefined || ranges.includes(e.range);
	const targetMatches = (e: CaptureEvent) =>
		target === undefined ||
		(e.target?.role === target.role && e.target.nameHash === hash);
	const content =
		holds === undefined ? [] : events.map((e) => captureRangeScore(e, holds));
	return {
		matching: events.filter(
			(e) =>
				(ranges === undefined || ranges.includes(e.range)) &&
				(target === undefined ||
					(e.target?.role === target.role && e.target.nameHash === hash)) &&
				(holds === undefined || captureRangeScore(e, holds).ok),
		).length,
		invalid: events.filter((e) => captureProblem(e, captureDir) !== null)
			.length,
		wrongRange: events.filter((e) => !rangeMatches(e)).length,
		wrongTarget: events.filter((e) => !targetMatches(e)).length,
		contentMismatch: content.filter(
			(s) => s.missing.length > 0 || s.extra.length > 0,
		).length,
		unconfirmed: content.filter((s) => s.unconfirmed).length,
	};
}
