import { openLabDb } from "../../host/db.ts";
import { acquireRunLock } from "../../host/lock.ts";
import { createExperiment } from "../../host/store.ts";
import { FakeBrowser } from "../host/fake-adapter.ts";
import { runScripted } from "../host/harness.ts";
const [phase, path, receiver] = process.argv.slice(2) as [
	string,
	string,
	string,
];
const lock = acquireRunLock(`${path}.run.lock`);
const db = openLabDb(path);
createExperiment(db, {
	id: "exp-1",
	name: "crash",
	caseIds: [],
	caseDigest: "crash-v1",
	includesHoldout: false,
	repetitions: 1,
	arms: ["arm1"],
	budget: {},
	inferenceKind: "scripted",
	nowIso: new Date().toISOString(),
});
function stopAt(point: string) {
	if (point !== phase) return;
	process.stdout.write(
		JSON.stringify({ phase: point, pid: process.pid }) + "\n",
	);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const adapter = new FakeBrowser();
const observe = adapter.observe.bind(adapter);
adapter.observe = async (...args) => {
	stopAt("before_intent");
	return observe(...args);
};
const dispatch = adapter.dispatch.bind(adapter);
adapter.dispatch = async (...args) => {
	const result = await dispatch(...args);
	if (args[0].action === "page.click") {
		await fetch(receiver, { method: "POST" });
		stopAt("external_effect");
	}
	return result;
};
let commit: string | null = null;
await runScripted("dev-form-base", {
	db,
	adapter,
	onEvent(e) {
		if (e.type === "operation.requested" && e.command.action === "page.click") {
			commit = e.operationId;
			stopAt("intent_committed");
		}
		if (e.type === "operation.dispatched" && e.operationId === commit)
			stopAt("dispatched_committed");
		if (e.type === "operation.result" && e.operationId === commit)
			stopAt("settled");
	},
	beforeFinish: async () => {
		stopAt("before_completion");
		return { ok: true };
	},
});
stopAt("completed");
lock.release();
db.close();
