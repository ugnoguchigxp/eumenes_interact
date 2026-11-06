import type {
	ArmId,
	CoreState,
	HostOutcome,
	ShapedObservation,
	StartRunInput,
} from "../contracts/core.ts";
import type { RawObservation } from "../contracts/observation.ts";
import { refsOf } from "./parts/snapshot.ts";
import * as arm1 from "./arm1/run.ts";

/** Arm 0 (the Eumenes baseline port) was removed in M4; every state is an Arm 1 state. */
const armOf = (_state: CoreState) => arm1;

export const startRun = (input: StartRunInput): CoreState =>
	arm1.startRun(input);

export const prepareStep = (state: CoreState) =>
	armOf(state).prepareStep(state);

export const parseStep = (state: CoreState, raw: string) =>
	armOf(state).parseStep(state, raw);

export const applyResult = (state: CoreState, outcome: HostOutcome) =>
	armOf(state).applyResult(state, outcome);

/**
 * Arm 1 keeps the whole body: its parts read it in full and show the AI only bounded summaries, so a cut here
 * would hide items.
 */
export function shapeObservation(
	arm: ArmId,
	raw: RawObservation,
): ShapedObservation {
	if (arm !== "arm1") throw new Error("unknown_arm");
	const refs = refsOf(raw.body);
	return {
		body: raw.body,
		truncated: false,
		truncationReasons: [],
		refCount: refs.length,
		refs,
	};
}

export const parseCoreState = (value: unknown): CoreState | null =>
	arm1.parseCoreState(value);
