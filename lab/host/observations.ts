import {
	constants,
	closeSync,
	mkdirSync,
	openSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Observation bodies of real sites (plan.md §14): not persisted by default. A run the user asks to keep them
 * (`--keep-observations`) writes each shaped body, with its URL and title, to a dedicated area, one directory
 * per trial; directories older than the retention period are deleted at the start of the next `run`.
 */

export const DEFAULT_OBSERVATIONS_DIR = fileURLToPath(
	new URL("../data/observations", import.meta.url),
);

/** The longest a kept observation stays (plan.md §14: at most 7 days). */
export const OBSERVATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type KeptObservation = { url?: string; title?: string; body: string };

/** Called for every observation the model is shown. `seq` counts from 1 within the trial. */
export type ObservationSink = (
	trialId: string,
	seq: number,
	observation: KeptObservation,
) => void;

/** Writes `<dir>/<trialId>/<seq>.txt`, readable by the owner only. */
export function createObservationSink(dir: string): ObservationSink {
	if (!isAbsolute(dir)) throw new Error("observation_root_not_absolute");
	return (trialId, seq, observation) => {
		if (
			!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(trialId) ||
			!Number.isSafeInteger(seq) ||
			seq < 1
		)
			throw new Error("observation_id_invalid");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const root = realpathSync(dir);
		const trialDir = join(dir, trialId);
		mkdirSync(trialDir, { recursive: true, mode: 0o700 });
		const actual = realpathSync(trialDir);
		if (dirname(actual) !== root) throw new Error("observation_dir_changed");
		const fd = openSync(
			join(actual, `${seq}.txt`),
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeFileSync(
				fd,
				[
					`url: ${observation.url ?? ""}`,
					`title: ${observation.title ?? ""}`,
					"",
					observation.body,
					"",
				].join("\n"),
			);
		} finally {
			closeSync(fd);
		}
	};
}

/**
 * Deletes trial directories not modified within `maxAgeMs`. Only plain directories directly under `dir`
 * are touched: a symlink or a file there is left alone. Returns the names removed.
 */
export async function pruneObservations(
	dir: string,
	nowMs: number,
	maxAgeMs: number = OBSERVATION_RETENTION_MS,
): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of names) {
		const path = join(dir, name);
		const info = await lstat(path);
		if (!info.isDirectory() || nowMs - info.mtimeMs <= maxAgeMs) continue;
		await rm(path, { recursive: true, force: true });
		removed.push(name);
	}
	return removed;
}
