import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

export class RunnerActiveError extends Error {
	constructor(readonly pid: number) {
		super(`runner_active:${pid}`);
		this.name = "RunnerActiveError";
	}
}
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
function identity(pid: number): string | null {
	const p = spawnSync(
		"/bin/ps",
		["-p", String(pid), "-o", "lstart=", "-o", "comm="],
		{ encoding: "utf8" },
	);
	return p.status === 0 && p.stdout.trim() ? p.stdout.trim() : null;
}
/** OS process identity only; failure to inspect a live process is conservative. */
export function runnerAlive(pid: number): boolean {
	if (!processAlive(pid)) return false;
	const p = spawnSync("/bin/ps", ["-p", String(pid), "-o", "comm="], {
		encoding: "utf8",
	});
	if (p.status !== 0) return true;
	return ["bun", "node"].includes(basename(p.stdout.trim()));
}
type Owner = { pid: number; generation?: string; identity?: string | null };
function ownerOf(path: string): Owner | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (Number.isSafeInteger(raw) && raw > 0) return { pid: raw }; // legacy lock
		return Number.isSafeInteger(raw?.pid) && raw.pid > 0 ? raw : null;
	} catch {
		return null;
	}
}
export type RunLock = { release(): void };
/** SQLite's OS lock serializes reclamation and is released by the OS on a crash. Never unlink its file. */
export function acquireRunLock(
	path: string,
	isAlive = runnerAlive,
	pid = process.pid,
): RunLock {
	mkdirSync(dirname(path), { recursive: true });
	const guard = new Database(`${path}.guard.sqlite`);
	try {
		guard.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
	} catch {
		guard.close();
		throw new RunnerActiveError(ownerOf(path)?.pid ?? 0);
	}
	try {
		const old = ownerOf(path);
		if (
			old &&
			isAlive(old.pid) &&
			(!old.identity || old.identity === identity(old.pid))
		)
			throw new RunnerActiveError(old.pid);
		const owner = { pid, generation: randomUUID(), identity: identity(pid) };
		writeFileSync(path, JSON.stringify(owner) + "\n", { mode: 0o600 });
		let released = false;
		return {
			release() {
				if (released) return;
				released = true;
				try {
					if (ownerOf(path)?.generation === owner.generation) unlinkSync(path);
				} finally {
					guard.exec("ROLLBACK");
					guard.close();
				}
			},
		};
	} catch (e) {
		guard.exec("ROLLBACK");
		guard.close();
		throw e;
	}
}
