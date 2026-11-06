import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { CapturedImage } from "../../index.ts";

/**
 * Where screenshots go (plan.md §6.4). The caller chooses a directory per run; the model never chooses a path
 * or a name. The directory must exist and be absolute, it is resolved through symlinks, and nothing is
 * written outside it. A file is created exclusively, so an existing one is never overwritten. The default
 * (no directory given) is the lab's own area under `lab/data/captures/<runId>/`, cleaned like kept
 * observations (at most 7 days, plan.md §14).
 */

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
	/** A host may encode the captured PNG/JPEG to its managed WebP format before saving. */
	mediaType: CapturedImage["mediaType"] | "image/webp";
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
	private readonly defaultRoot: string | null;

	constructor(options: CaptureStoreOptions) {
		if (
			typeof options.runId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.runId)
		)
			throw new CaptureError("capture_run_id_invalid");
		// A hash of the whole id: the first characters of a time-ordered id (UUIDv7) are the same for runs
		// started close together, and two such runs sharing a directory would meet `capture_exists`.
		this.short = createHash("sha256")
			.update(options.runId)
			.digest("hex")
			.slice(0, 12);
		this.defaultRoot =
			options.dir === undefined ? (options.defaultRoot ?? null) : null;
		if (options.dir === undefined) {
			if (!this.defaultRoot || !isAbsolute(this.defaultRoot))
				throw new CaptureError("capture_root_required");
			this.real = null;
			this.dirPath = join(
				options.defaultRoot ??
					(() => {
						throw new CaptureError("capture_root_required");
					})(),
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
			await mkdir(this.defaultRoot!, { recursive: true, mode: 0o700 });
			const parent = await realpath(this.defaultRoot!);
			await mkdir(this.dirPath, { recursive: true, mode: 0o700 });
			const actual = await realpath(this.dirPath);
			if (dirname(actual) !== parent)
				throw new CaptureError("capture_dir_changed");
			this.real = actual;
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
