import { expect, test } from "bun:test";
import { getRun, listOperations, listRuns } from "eumenes-interact/sqlite";
import { freshDb, runScripted } from "./harness.ts";
import { FakeBrowser } from "./fake-adapter.ts";
import { LAB_OWNER } from "../../host/run.ts";
import { listTrials } from "../../host/store.ts";
import { reconcileOnStartup } from "../../host/reconcile.ts";
import { silentLabLogger } from "../../host/log.ts";

test("a settle write failure preserves the sent operation and reports indeterminate, without resending", async () => {
	const db = freshDb();
	const adapter = new FakeBrowser();
	db.exec(
		`CREATE TRIGGER injected BEFORE UPDATE OF status ON interact_operations WHEN NEW.status='confirmed' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SETTLE_FAILURE'); END`,
	);
	try {
		const { result } = await runScripted("dev-form-base", { db, adapter });
		expect(result.status).toBe("indeterminate");
		expect(result.code).toBe("operation_persistence_failed");
		expect(getRun(db, LAB_OWNER, result.runId)?.status).toBe("indeterminate");
		expect(
			listOperations(db, LAB_OWNER, result.runId).some(
				(o) => o.status === "dispatched",
			),
		).toBe(true);
		expect(
			result.transcript.events.some(
				(e) => e.type === "operation.result" && e.adopted,
			),
		).toBe(false);
		const sent = adapter.dispatched.length;
		db.exec("DROP TRIGGER injected");
		reconcileOnStartup(db, LAB_OWNER, silentLabLogger);
		expect(
			listOperations(db, LAB_OWNER, result.runId).some(
				(o) => o.status === "indeterminate",
			),
		).toBe(true);
		expect(adapter.dispatched.length).toBe(sent);
	} finally {
		db.close();
	}
});

for (const table of ["interact_runs", "lab_trials"] as const) {
	test(`${table} terminal write failure cannot publish completion or split run/trial commits`, async () => {
		const db = freshDb();
		const published: string[] = [];
		const trigger =
			table === "interact_runs"
				? "UPDATE OF status ON interact_runs WHEN NEW.status='completed'"
				: "UPDATE OF state ON lab_trials WHEN NEW.state='finished'";
		db.exec(
			`CREATE TRIGGER injected BEFORE ${trigger} BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FINAL_WRITE_FAILURE'); END`,
		);
		try {
			await expect(
				runScripted("dev-search-base", {
					db,
					onEvent: (e) => {
						if (e.type === "step.final") published.push(e.kind);
					},
				}),
			).rejects.toThrow("run_persistence_failed");
			const [run] = listRuns(db, LAB_OWNER, {});
			expect(run?.status).toBe("running");
			expect(listTrials(db)[0]?.state).toBe("running");
			expect(published).toEqual([]);
			db.exec("DROP TRIGGER injected");
			reconcileOnStartup(db, LAB_OWNER, silentLabLogger);
			expect(getRun(db, LAB_OWNER, run!.runId)?.status).toBe("failed");
			expect(listTrials(db)[0]?.state).toBe("interrupted");
		} finally {
			db.close();
		}
	});
}
