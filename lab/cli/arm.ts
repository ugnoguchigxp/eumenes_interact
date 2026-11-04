import type { ArmId } from "eumenes-interact";
import { resolveCaptureDir } from "../host/parts/capture.ts";

/** `--arm arm1` (plan.md §6.4): the registered parts. Arm 0 (the baseline port) was removed in M4. */
export function parseArm(value: string | undefined, fallback: ArmId): ArmId {
	if (value === undefined) return fallback;
	if (value === "arm1") return value;
	throw new Error(`invalid_arm:${value} (arm1)`);
}

/**
 * Arm 1 asks the model for output that follows a JSON Schema; the LARM path does not enforce one yet, so the
 * combination is refused before anything starts instead of failing on the first call.
 */
export function checkArmInference(arm: ArmId, inference: string) {
	if (arm === "arm1" && inference === "larm")
		throw new Error(
			"arm1_needs_structured_output: use --inference claude (or scripted); LARM does not enforce a schema yet",
		);
}

/**
 * `--capture-dir <abs path>`: an existing absolute directory, resolved through symlinks. Refused here, before a
 * lock, a database or a browser is touched. Returns the real path.
 */
export function parseCaptureDir(value: string | undefined): string | undefined {
	return value === undefined ? undefined : resolveCaptureDir(value);
}
