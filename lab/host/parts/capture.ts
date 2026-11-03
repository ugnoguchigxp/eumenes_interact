import { realpathSync, statSync } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapturedImage } from "eumenes-interact";

/**
 * Where screenshots go (plan.md §6.4). The caller chooses a directory per run; the model never chooses a path
 * or a name. The directory must exist and be absolute, it is resolved through symlinks, and nothing is
 * written outside it. A file is created exclusively, so an existing one is never overwritten. The default
 * (no directory given) is the lab's own area under `lab/data/captures/<runId>/`, cleaned like kept
 * observations (at most 7 days, plan.md §14).
 */

export const DEFAULT_CAPTURES_DIR = fileURLToPath(
	new URL("../../data/captures", import.meta.url),
);

export type CaptureRange = "viewport" | "full" | "item";

/** A fixed classification: the message is the code, never a path. */
export class CaptureError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "CaptureError";
	}
}

/**
 * The real path of an existing absolute directory. Synchronous so a caller can refuse a bad `--capture-dir`
 * before it takes a lock or opens anything.
 */
export function resolveCaptureDir(dir: string): string {
	if (typeof dir !== "string" || dir === "" || dir.includes("\0"))
		throw new CaptureError("capture_dir_invalid");
	if (!isAbsolute(dir)) throw new CaptureError("capture_dir_not_absolute");
	let real: string;
	try {
		real = realpathSync(dir);
	} catch {
		throw new CaptureError("capture_dir_missing");
	}
	if (!statSync(real).isDirectory())
		throw new CaptureError("capture_dir_not_directory");
	return real;
}

export type SavedCapture = {
	captureId: string;
	fileName: string;
	width: number;
	height: number;
	bytes: number;
	mediaType: CapturedImage["mediaType"];
	range: CaptureRange;
};

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const startsWith = (bytes: Uint8Array, magic: readonly number[]) =>
	magic.every((b, i) => bytes[i] === b);

/** The image the adapter returned must be what it says it is, non-empty and with a size. */
function validate(image: CapturedImage) {
	const magic = image.mediaType === "image/png" ? PNG : JPEG;
	if (
		image.bytes.length === 0 ||
		!startsWith(image.bytes, magic) ||
		!Number.isInteger(image.width) ||
		!Number.isInteger(image.height) ||
		image.width < 1 ||
		image.height < 1
	)
		throw new CaptureError("capture_invalid_image");
}

export type CaptureStoreOptions = {
	runId: string;
	/** An existing absolute directory (as given by the caller); the default area is made when first used. */
	dir?: string;
	/** Parent of the default `<runId>` directory. */
	defaultRoot?: string;
};

/**
 * The files of one run. Names are made from the run id, the capture's number and its range, so a name cannot
 * carry anything the page or the model said.
 */
export class CaptureStore {
	private seq = 0;
	private real: string | null;
	private readonly dirPath: string;
	private readonly short: string;

	constructor(options: CaptureStoreOptions) {
		this.short = options.runId.replaceAll("-", "").slice(0, 8);
		if (options.dir === undefined) {
			this.real = null;
			this.dirPath = join(
				options.defaultRoot ?? DEFAULT_CAPTURES_DIR,
				options.runId,
			);
		} else {
			this.real = resolveCaptureDir(options.dir);
			this.dirPath = this.real;
		}
	}

	/** The directory as the transcript names it: absolute, and what the scorer looks in. */
	get dir(): string {
		return this.real ?? this.dirPath;
	}

	/** Ensures the directory is the real one it was at the start (a swapped link is refused). */
	private async directory(): Promise<string> {
		if (this.real === null) {
			await mkdir(this.dirPath, { recursive: true, mode: 0o700 });
			this.real = await realpath(this.dirPath);
			return this.real;
		}
		let now: string;
		try {
			now = await realpath(this.dirPath);
		} catch {
			throw new CaptureError("capture_dir_missing");
		}
		if (now !== this.real) throw new CaptureError("capture_dir_changed");
		return this.real;
	}

	async save(range: CaptureRange, image: CapturedImage): Promise<SavedCapture> {
		validate(image);
		const root = await this.directory();
		const seq = ++this.seq;
		const extension = image.mediaType === "image/png" ? "png" : "jpg";
		const fileName = `${this.short}-${seq}-${range}.${extension}`;
		const path = join(root, fileName);
		// The name is built here and has no separator; the check is for the next person who edits it.
		if (basename(path) !== fileName || !path.startsWith(root + sep))
			throw new CaptureError("capture_path_refused");
		let handle;
		try {
			handle = await open(
				path,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			throw new CaptureError(
				code === "EEXIST" || code === "ELOOP"
					? "capture_exists"
					: "capture_write_failed",
			);
		}
		try {
			await handle.writeFile(image.bytes);
		} catch {
			throw new CaptureError("capture_write_failed");
		} finally {
			await handle.close();
		}
		return {
			captureId: `c${seq}`,
			fileName,
			width: image.width,
			height: image.height,
			bytes: image.bytes.length,
			mediaType: image.mediaType,
			range,
		};
	}
}
