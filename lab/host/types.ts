import type { ArmId } from "eumenes-interact";

/** Facts that identify what a trial ran on (plan.md §14). Filled by `collectVersions` and the adapter. */
export type TrialVersions = {
	/** The package's commit when the repository has one; null before the first commit. */
	packageCommit: string | null;
	coreFormatVersion: number;
	arm0SourceCommit: string;
	/** The external tool the adapter reported after it opened; version null when unknown. */
	tool: { name: string; version: string | null };
	os: string;
	runtime: string;
	browser: {
		channel: string | null;
		customExecutable: boolean;
		headless: boolean;
	};
};

/** What the inference port reported about itself (never a token). */
export type InferenceInfo =
	| { kind: "scripted" }
	| { kind: "larm"; profile: string; model: string | null };

/** The comparison conditions of one trial (plan.md §10.3). Arm 0 is the only arm; the rest are fixed. */
export type TrialConditions = {
	arm: ArmId;
	platform: string;
	executionMode: "free";
	knowledge: "none";
};

/** A refusal before anything was sent: the code goes back to the model as the tool's result. */
export class Refusal extends Error {
	constructor(
		readonly code: string,
		readonly retryable = true,
	) {
		super(code);
		this.name = "Refusal";
	}
}

/** Why a run ends from inside the executor, not through the core. */
export type RunEndStatus = "cancelled" | "expired" | "indeterminate" | "failed";

export class RunEnd extends Error {
	constructor(
		readonly status: RunEndStatus,
		readonly code: string,
	) {
		super(`${status}:${code}`);
		this.name = "RunEnd";
	}
}
