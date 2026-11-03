import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ArmId, InferencePort, PlatformAdapter } from "eumenes-interact";
import type { CaseDef } from "../cases/schema.ts";
import type { Approver } from "./approval.ts";
import { RunControl } from "./control.ts";
import type { ObservationSink } from "./observations.ts";
import type { LabLogger } from "./log.ts";
import { caseDigest, planTrials } from "./plan.ts";
import {
	CALL_MS,
	MIN_CALL_MS,
	OUTPUT_TOKENS,
	runPolicy,
	runTrial,
	type TrialResult,
} from "./run.ts";
import { createExperiment } from "./store.ts";
import type { InferenceInfo, InferenceKind, TrialVersions } from "./types.ts";

/** What differs between a real run and a test: where the adapter, the inference and the approver come from. */
export type TrialFactories = {
	/** A fresh session per trial: the fixture and the browser start from the same state each time. */
	adapter(def: CaseDef): Promise<{
		adapter: PlatformAdapter;
		dispose(): Promise<void>;
	}>;
	inference(
		def: CaseDef,
		arm: ArmId,
	): Promise<{
		port: InferencePort;
		info: () => InferenceInfo;
		dispose(): Promise<void>;
	}>;
	approver(def: CaseDef): Approver;
};

export type ExperimentInput = {
	db: Database;
	cases: readonly CaseDef[];
	arms: readonly ArmId[];
	repetitions: number;
	name: string;
	inferenceKind: InferenceKind;
	/** The model and effort a Claude run was frozen to: recorded with the experiment's other conditions. */
	frozenInference?: { model: string; effort: string; maxTokens?: number };
	includesHoldout: boolean;
	includesLive?: boolean;
	factories: TrialFactories;
	logger: LabLogger;
	versions: TrialVersions;
	/** Required unless every case is live. */
	fixtureBaseUrl?: string;
	observationSink?: ObservationSink;
	/** Arm 1: an existing absolute directory every trial's screenshots go to; default: the lab's area per run. */
	captureDir?: string;
	/** Where the default capture directories are made (tests). */
	captureRoot?: string;
	now?: () => number;
	/** Gives the caller the current trial's control (a signal handler cancels through it). */
	onControl?: (control: RunControl) => void;
	onTrial?: (result: TrialResult, def: CaseDef) => void;
};

/**
 * Freezes the experiment (cases, repetitions, budget, arms) and runs its trials in the planned order, one at
 * a time. A case Arm 0 cannot hold is refused before anything is stored or started. A cancel stops the
 * remaining trials.
 */
export async function runExperiment(input: ExperimentInput) {
	const now = input.now ?? Date.now;
	for (const def of input.cases) runPolicy(def);
	const experimentId = randomUUID();
	createExperiment(input.db, {
		id: experimentId,
		name: input.name,
		caseIds: input.cases.map((c) => c.id),
		caseDigest: caseDigest(input.cases),
		includesHoldout: input.includesHoldout,
		includesLive: input.includesLive === true,
		repetitions: input.repetitions,
		arms: input.arms,
		budget: {
			maxModelCalls: Object.fromEntries(
				input.cases.map((c) => [c.id, c.budget.maxModelCalls]),
			),
			outputTokens: OUTPUT_TOKENS,
			callMs: CALL_MS,
			minCallMs: MIN_CALL_MS,
			inference: {
				kind: input.inferenceKind,
				...input.frozenInference,
			},
		},
		inferenceKind: input.inferenceKind,
		nowIso: new Date(now()).toISOString(),
	});
	const results: TrialResult[] = [];
	for (const planned of planTrials(
		input.cases,
		input.arms,
		input.repetitions,
	)) {
		const control = new RunControl();
		input.onControl?.(control);
		const session = await input.factories.adapter(planned.def);
		const inference = await input.factories.inference(planned.def, planned.arm);
		try {
			const result = await runTrial({
				db: input.db,
				def: planned.def,
				arm: planned.arm,
				experimentId,
				repetition: planned.repetition,
				orderIndex: planned.orderIndex,
				adapter: session.adapter,
				inference: inference.port,
				inferenceInfo: inference.info,
				approver: input.factories.approver(planned.def),
				logger: input.logger,
				versions: input.versions,
				...(input.fixtureBaseUrl
					? { fixtureBaseUrl: input.fixtureBaseUrl }
					: {}),
				...(input.observationSink
					? { observationSink: input.observationSink }
					: {}),
				...(input.captureDir ? { captureDir: input.captureDir } : {}),
				...(input.captureRoot ? { captureRoot: input.captureRoot } : {}),
				now,
				control,
			});
			results.push(result);
			input.onTrial?.(result, planned.def);
		} finally {
			await inference.dispose();
			await session.dispose();
		}
		if (control.reason === "cancel") break;
	}
	return { experimentId, results };
}
