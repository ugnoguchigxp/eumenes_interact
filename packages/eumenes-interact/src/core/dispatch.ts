import type {
	ArmId,
	CoreState,
	HostOutcome,
	ShapedObservation,
	StartRunInput,
} from "../contracts/core.ts";
import type { RawObservation } from "../contracts/observation.ts";
import * as arm0 from "./arm0/run.ts";
import { refsOf } from "./arm0/observation.ts";
import * as arm1 from "./arm1/run.ts";

/** The arm a stored state belongs to; a state that is not a core state has none. */
const armOf = (state: CoreState) => (state.arm === "arm1" ? arm1 : arm0);

export const startRun = (input: StartRunInput): CoreState => {
	if (input.arm === "arm1") return arm1.startRun(input);
	return arm0.startRun(input);
};

export const prepareStep = (state: CoreState) =>
	armOf(state).prepareStep(state);

export const parseStep = (state: CoreState, raw: string) =>
	armOf(state).parseStep(state, raw);

export const applyResult = (state: CoreState, outcome: HostOutcome) =>
	armOf(state).applyResult(state, outcome);

/**
 * Arm 0 bounds the snapshot as Eumenes does. Arm 1 keeps the whole body: its parts read it in full and show
 * the AI only bounded summaries, so a cut here would hide items.
 */
export function shapeObservation(
	arm: ArmId,
	raw: RawObservation,
): ShapedObservation {
	if (arm === "arm0") return arm0.shapeObservation(arm, raw);
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
	arm0.parseCoreState(value) ?? arm1.parseCoreState(value);
