import type { Database } from "bun:sqlite";
import type { InferencePort } from "eumenes-interact";
import { loadCases } from "../../cases/load.ts";
import type { CaseDef } from "../../cases/schema.ts";
import { FixtureApprover, type Approver } from "../../host/approval.ts";
import type { RunControl } from "../../host/control.ts";
import { openLabDb } from "../../host/db.ts";
import type { TranscriptEvent } from "../../scorer/transcript.ts";
import type { InferenceInfo } from "../../host/types.ts";
import type { ObservationSink } from "../../host/observations.ts";
import { silentLabLogger } from "../../host/log.ts";
import { runTrial, type TrialResult } from "../../host/run.ts";
import { createExperiment } from "../../host/store.ts";
import { collectVersions } from "../../host/versions.ts";
import { createScriptedInference } from "../../scripted/inference.ts";
import { loadScript } from "../../scripted/script.ts";
import { BASE, FakeBrowser } from "./fake-adapter.ts";

export async function devCase(id: string): Promise<CaseDef> {
	const found = (await loadCases({ includeHoldout: false })).find(
		(c) => c.id === id,
	);
	if (!found) throw new Error(`no dev case ${id}`);
	return found;
}

export const VERSIONS = collectVersions({
	browser: { channel: null, customExecutable: false, headless: true },
	commit: null,
});

export function freshDb(): Database {
	const db = openLabDb(":memory:");
	createExperiment(db, {
		id: "exp-1",
		name: "test",
		caseIds: [],
		caseDigest: "digest",
		includesHoldout: false,
		repetitions: 1,
		arms: ["arm0"],
		budget: {},
		inferenceKind: "scripted",
		nowIso: new Date().toISOString(),
	});
	return db;
}

export type Harness = {
	db: Database;
	def: CaseDef;
	adapter: FakeBrowser;
	result: TrialResult;
};

/** Runs one dev case's script against the fake browser. Anything can be swapped. */
export async function runScripted(
	caseId: string,
	options: {
		db?: Database;
		adapter?: FakeBrowser;
		approver?: Approver;
		inference?: InferencePort;
		inferenceInfo?: InferenceInfo;
		control?: RunControl;
		def?: CaseDef;
		deadlineMs?: number;
		now?: () => number;
		observationSink?: ObservationSink;
		onEvent?: (event: TranscriptEvent) => void;
	} = {},
): Promise<Harness> {
	const def = options.def ?? (await devCase(caseId));
	const db = options.db ?? freshDb();
	const adapter = options.adapter ?? new FakeBrowser();
	const result = await runTrial({
		db,
		def,
		arm: "arm0",
		experimentId: "exp-1",
		repetition: 1,
		orderIndex: 0,
		adapter,
		inference:
			options.inference ?? createScriptedInference(await loadScript(caseId)),
		inferenceInfo: () => options.inferenceInfo ?? { kind: "scripted" },
		approver: options.approver ?? new FixtureApprover(def.approvalScript),
		logger: silentLabLogger,
		versions: VERSIONS,
		fixtureBaseUrl: BASE,
		...(options.control ? { control: options.control } : {}),
		...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
		...(options.now ? { now: options.now } : {}),
		...(options.onEvent ? { onEvent: options.onEvent } : {}),
		...(options.observationSink
			? { observationSink: options.observationSink }
			: {}),
	});
	return { db, def, adapter, result };
}
