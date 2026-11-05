import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmId, InferencePort } from "eumenes-interact";
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
import {
	createArm1ScriptedInference,
	loadArm1Script,
} from "../../scripted/arm1.ts";
import { BASE, FakeBrowser } from "./fake-adapter.ts";

let captureRoot: string | null = null;
/** Where a test's default capture directories go (removed when the process ends): never the repository. */
export function testCaptureRoot(): string {
	if (captureRoot === null) {
		const root = mkdtempSync(join(tmpdir(), "interact-captures-test-"));
		captureRoot = root;
		process.on("exit", () => rmSync(root, { recursive: true, force: true }));
	}
	return captureRoot;
}

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
		arms: ["arm1"],
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
		authorityRequest?: string;
		inferenceInfo?: InferenceInfo;
		control?: RunControl;
		def?: CaseDef;
		deadlineMs?: number;
		now?: () => number;
		observationSink?: ObservationSink;
		onEvent?: (event: TranscriptEvent) => void;
		arm?: ArmId;
		captureDir?: string;
		captureRoot?: string;
		beforeFinish?: Parameters<typeof runTrial>[0]["beforeFinish"];
	} = {},
): Promise<Harness> {
	const def = options.def ?? (await devCase(caseId));
	const db = options.db ?? freshDb();
	const adapter = options.adapter ?? new FakeBrowser();
	const arm = options.arm ?? "arm1";
	const result = await runTrial({
		db,
		def,
		arm,
		experimentId: "exp-1",
		repetition: 1,
		orderIndex: 0,
		adapter,
		inference:
			options.inference ??
			createArm1ScriptedInference(await loadArm1Script(caseId)),
		inferenceInfo: () => options.inferenceInfo ?? { kind: "scripted" },
		approver: options.approver ?? new FixtureApprover(def.approvalScript),
		logger: silentLabLogger,
		versions: VERSIONS,
		fixtureBaseUrl: BASE,
		...(options.authorityRequest === undefined
			? {}
			: { authorityRequest: options.authorityRequest }),
		captureRoot: options.captureRoot ?? testCaptureRoot(),
		...(options.captureDir ? { captureDir: options.captureDir } : {}),
		...(options.control ? { control: options.control } : {}),
		...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
		...(options.now ? { now: options.now } : {}),
		...(options.beforeFinish ? { beforeFinish: options.beforeFinish } : {}),
		...(options.onEvent ? { onEvent: options.onEvent } : {}),
		...(options.observationSink
			? { observationSink: options.observationSink }
			: {}),
	});
	return { db, def, adapter, result };
}
