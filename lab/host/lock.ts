import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One runner at a time. Reconciliation settles every dispatched operation as `indeterminate`, which is only
 * right when no other process is running one, so `run` takes this lock before it reconciles and holds it
 * until it ends. The lock is a file holding the owner's pid, created exclusively; a lock whose pid is gone is
 * stale and taken over. Read-only commands never take it.
 */

export class RunnerActiveError extends Error {
	constructor(readonly pid: number) {
		super(`runner_active:${pid}`);
		this.name = "RunnerActiveError";
	}
}

/** Whether a process exists. EPERM means it exists but is not ours. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Whether a live pid is a runner (bun or node). A pid that the system reused for another program after the
 * runner died leaves a stale lock; without /proc (not Linux) a live pid is taken as a runner.
 */
export function runnerAlive(pid: number): boolean {
	if (!processAlive(pid)) return false;
	try {
		const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
		return /\b(bun|node)\b/.test(cmd);
	} catch {
		return true;
	}
}

export type RunLock = { release(): void };

function ownerOf(path: string): number | null {
	try {
		const pid = Number(readFileSync(path, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

export function acquireRunLock(
	path: string,
	isAlive: (pid: number) => boolean = runnerAlive,
	pid: number = process.pid,
): RunLock {
	mkdirSync(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, `${pid}\n`, { flag: "wx", mode: 0o600 });
			return {
				release() {
					// Only the owner removes it.
					if (ownerOf(path) === pid) unlinkSync(path);
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = ownerOf(path);
		if (owner !== null && isAlive(owner)) throw new RunnerActiveError(owner);
		// Stale (the owner is gone, or the file is unreadable): remove it unless it changed meanwhile.
		if (ownerOf(path) === owner) unlinkSync(path);
	}
	throw new RunnerActiveError(ownerOf(path) ?? 0);
}
