import type { ArmId } from "eumenes-interact";
import type { CaseDef } from "../cases/schema.ts";

/** Facts that identify what a trial ran on (plan.md §14). Filled by `collectVersions` and the adapter. */
export type TrialVersions = {
	/** The package's commit when the repository has one; null before the first commit. */
	packageCommit: string | null;
	coreFormatVersion: number;
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
	| { kind: "larm"; profile: string; model: string | null }
	| {
			kind: "openai";
			provider: "openai";
			model: string;
			effort: string;
			completionReview?: "dual";
	  }
	| {
			kind: "claude";
			completionReview?: "dual";
			provider: "anthropic";
			model: string;
			effort: string;
			/** The output bound per call, when the run set one (`--max-tokens`). */
			maxTokens?: number;
	  };

/** An operate run's case id starts with this: it is a free-form request, not a trial of a case. */
export const OPERATE_CASE_PREFIX = "operate-";

/** The experiment's inference, as the experiments table stores it. */
export type InferenceKind = InferenceInfo["kind"];

/**
 * A case a trial can run: the pieces `runTrial` reads. `expect` is absent for a free-form request (`operate`):
 * the run and its transcript are stored and its counters computed, but nothing is judged a success.
 */
export type TrialCase = Omit<CaseDef, "expect"> & {
	expect?: CaseDef["expect"];
	/**
	 * A chain step on the user's behalf (2026-11-04, user decision): it may leave its start site for any
	 * public https/http page without approval. The URL policy still refuses private hosts, credentials and
	 * other schemes; challenge pages are still reported, never passed.
	 */
	openWeb?: boolean;
};

/** The comparison conditions of one trial (plan.md §10.3). Arm 0 is the only arm; the rest are fixed. */
export type TrialConditions = {
	arm: ArmId;
	platform: string;
	executionMode: "free";
	knowledge: "none";
};

export { Refusal, RunEnd, type RunEndStatus } from "eumenes-interact/parts";

/** Terminal state and host record did not commit; no result may be adopted. */
export class RunPersistenceError extends Error {
	constructor() {
		super("run_persistence_failed");
		this.name = "RunPersistenceError";
	}
}
