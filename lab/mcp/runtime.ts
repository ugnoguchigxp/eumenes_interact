import { StopApprover } from "../host/approval.ts";
import { createSession } from "../cli/session.ts";
import { RunControl } from "../host/control.ts";
import { runDefinition } from "../host/definition-run.ts";
import { loadDefinitions } from "../host/definitions.ts";
import { DEFAULT_DB_PATH, openLabDb } from "../host/db.ts";
import { acquireRunLock } from "../host/lock.ts";
import { createPinoLogger } from "../host/log.ts";
import { startOperate } from "../host/operate.ts";
import { reconcileOnStartup } from "../host/reconcile.ts";
import { LAB_OWNER } from "../host/run.ts";
import { importSeed, loadSeeds } from "../knowledge/seed.ts";
import {
	CAPTURE_ROOTS_ENV,
	DefinitionNotFoundError,
	ORIGIN_ALLOWLIST_ENV,
	parseCaptureRoots,
	parseOriginAllowlist,
	type InteractDeps,
} from "./interact-server.ts";

/**
 * The real dependencies of the MCP server: the lab's own definitions, runner lock, database and browser
 * session. Mirrors what `task run` does for a real run, minus the terminal: no prompt, the approver stops.
 */

async function runLocked(
	request: Parameters<InteractDeps["runDefinition"]>[0],
	dbPath: string,
) {
	const found = (await loadDefinitions()).find(
		({ definition }) => definition.id === request.definitionId,
	);
	if (!found) throw new DefinitionNotFoundError();
	// Taken before the database is touched and held to the end: reconciliation below is only right when no
	// other runner is alive.
	const lock = acquireRunLock(`${dbPath}.run.lock`);
	let db: ReturnType<typeof openLabDb>;
	try {
		db = openLabDb(dbPath);
	} catch (error) {
		lock.release();
		throw error;
	}
	const logger = createPinoLogger();
	try {
		reconcileOnStartup(db, LAB_OWNER, logger);
		const nowIso = new Date().toISOString();
		for (const { seed } of await loadSeeds())
			importSeed(db, LAB_OWNER, seed, nowIso);
		const control = new RunControl();
		const cancel = () => control.cancel("cancel");
		if (request.signal.aborted) cancel();
		request.signal.addEventListener("abort", cancel, { once: true });
		const session = await createSession({ headed: request.headed }, logger);
		try {
			return await runDefinition({
				db,
				definition: found.definition,
				inputs: request.inputs,
				adapter: session.adapter,
				approver: new StopApprover(),
				logger,
				control,
				...(request.captureDir ? { captureDir: request.captureDir } : {}),
			});
		} finally {
			request.signal.removeEventListener("abort", cancel);
			await session.dispose();
		}
	} finally {
		logger.close();
		db.close();
		lock.release();
	}
}

/** The operator's limits, read once at start; a bad value stops the server. */
const operatorLimits = () => {
	const originAllowlist = parseOriginAllowlist(
		process.env[ORIGIN_ALLOWLIST_ENV],
	);
	const captureRoots = parseCaptureRoots(process.env[CAPTURE_ROOTS_ENV]);
	return {
		...(originAllowlist ? { originAllowlist } : {}),
		...(captureRoots ? { captureRoots } : {}),
	};
};

export function realDeps(dbPath: string = DEFAULT_DB_PATH): InteractDeps {
	return {
		async listDefinitions() {
			return (await loadDefinitions()).map(({ definition: d }) => ({
				id: d.id,
				revision: d.revision,
				title: d.title,
				allowedOrigins: d.allowedOrigins,
				inputs: {
					properties: d.inputs.properties,
					required: d.inputs.required,
				},
			}));
		},
		runDefinition: (request) => runLocked(request, dbPath),
		startOperate: (options) => startOperate({ ...options, dbPath }),
		now: Date.now,
		...operatorLimits(),
	};
}
