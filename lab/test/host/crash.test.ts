import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRun, listRuns, listOperations } from "eumenes-interact/sqlite";
import { openLabDb } from "../../host/db.ts";
import { reconcileOnStartup } from "../../host/reconcile.ts";
import { acquireRunLock, RunnerActiveError } from "../../host/lock.ts";
import { silentLabLogger } from "../../host/log.ts";
import { LAB_OWNER } from "../../host/run.ts";
const phases = [
	"before_intent",
	"intent_committed",
	"dispatched_committed",
	"external_effect",
	"settled",
	"before_completion",
	"completed",
];
for (const phase of phases)
	test(`SIGKILL at ${phase} preserves external effects and never resends on recovery`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "interact-crash-"));
		const path = join(dir, "lab.sqlite");
		let effects = 0;
		const receiver = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				effects++;
				return new Response("ok");
			},
		});
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../support/crash-child.ts"),
				phase,
				path,
				`http://127.0.0.1:${receiver.port}/effect`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		try {
			const reader = child.stdout.getReader();
			let buffer = "";
			const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
			try {
				while (!buffer.includes("\n")) {
					const c = await reader.read();
					if (c.done) throw new Error("child_exited_before_checkpoint");
					buffer += new TextDecoder().decode(c.value);
				}
			} finally {
				clearTimeout(timer);
				reader.releaseLock();
			}
			expect(JSON.parse(buffer.trim()).phase).toBe(phase);
			expect(() => acquireRunLock(`${path}.run.lock`)).toThrow(
				RunnerActiveError,
			);
			child.kill("SIGKILL");
			await child.exited;
			const lock = acquireRunLock(`${path}.run.lock`);
			const db = openLabDb(path);
			try {
				const before = effects;
				const [run] = listRuns(db, LAB_OWNER);
				expect(run).toBeDefined();
				reconcileOnStartup(db, LAB_OWNER, silentLabLogger);
				const status = getRun(db, LAB_OWNER, run!.runId)?.status;
				expect(status).toBe(
					phase === "completed"
						? "completed"
						: ["external_effect", "dispatched_committed"].includes(phase)
							? "indeterminate"
							: "failed",
				);
				expect(effects).toBe(before);
				expect(effects).toBe(
					[
						"external_effect",
						"settled",
						"before_completion",
						"completed",
					].includes(phase)
						? 1
						: 0,
				);
				if (phase === "external_effect")
					expect(listOperations(db, LAB_OWNER, run!.runId).at(-1)?.status).toBe(
						"indeterminate",
					);
				const again = reconcileOnStartup(db, LAB_OWNER, silentLabLogger);
				expect(again.settledOperations).toBe(0);
				expect(effects).toBe(before);
			} finally {
				db.close();
				lock.release();
			}
		} finally {
			child.kill("SIGKILL");
			await child.exited;
			receiver.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15000);
