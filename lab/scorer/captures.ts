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

export type CaptureCheck = {
	/** Capture events of the requested range (all when no range is asked) and of the expected target, when one is. */
	matching: number;
	/** Capture events, of any range, whose file failed a check. */
	invalid: number;
};

export function checkCaptures(
	events: readonly CaptureEvent[],
	captureDir: string | undefined,
	range: CaptureRange | readonly CaptureRange[] | undefined,
	target?: { role: string; name: string },
): CaptureCheck {
	const ranges: readonly CaptureRange[] | undefined =
		range === undefined || Array.isArray(range)
			? range
			: [range as CaptureRange];
	const hash =
		target === undefined ? undefined : captureTargetHash(target.name);
	return {
		matching: events.filter(
			(e) =>
				(ranges === undefined || ranges.includes(e.range)) &&
				(target === undefined ||
					(e.target?.role === target.role && e.target.nameHash === hash)),
		).length,
		invalid: events.filter((e) => captureProblem(e, captureDir) !== null)
			.length,
	};
}
