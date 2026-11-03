import type {
	AdapterCommand,
	DeclaredEffect,
	OperationResult,
} from "eumenes-interact";

/**
 * The trial transcript the host produces and `scoreTrial` consumes (plan.md §11, §14). It holds
 * facts only: no observation bodies, no model output, no input values beyond the commands sent.
 * Events are in the order the host recorded them; `at` is milliseconds since the trial started.
 */

export type ModelCallOutcome =
	"ok" | "refused" | "empty" | "malformed" | "error";

/** Token usage of one call. `null` means the provider did not report it (never 0). */
export type TokenUsage = { input: number | null; output: number | null };

export type FinalKind = "finish" | "clarify" | "failed" | "stopped";

type At = { at: number };

export type TranscriptEvent =
	| (At & {
			type: "model.call";
			durationMs: number;
			outcome: ModelCallOutcome;
			tokens: TokenUsage;
	  })
	/** The core's `parseStep` verdict on one model output. `reason` is the fixed rejection class. */
	| (At & { type: "step.parse"; accepted: boolean; reason?: string })
	| (At & {
			type: "observation";
			observationRef: string;
			url: string | null;
			title: string | null;
			refCount: number;
	  })
	| (At & {
			type: "operation.requested";
			operationId: string;
			command: AdapterCommand;
			declaredEffect: DeclaredEffect;
			/** The host's gate decision: this operation needs approval before it is sent. */
			requiresApproval: boolean;
			/** Set when the request repeats an earlier operation. */
			retryOf?: string;
	  })
	/** Written before the adapter is awaited: the command may now have reached the page. */
	| (At & { type: "operation.dispatched"; operationId: string })
	| (At & {
			type: "operation.result";
			operationId: string;
			status: OperationResult["status"];
			code?: string;
			url?: string;
			title?: string;
			/** The host fed this result to the model / the run state. */
			adopted: boolean;
	  })
	| (At & {
			type: "approval.requested";
			approvalId: string;
			operationId: string;
	  })
	| (At & {
			type: "approval.answered";
			approvalId: string;
			decision: "grant" | "deny";
	  })
	/** The run was cancelled or its deadline passed: no new send and no result adoption after this. */
	| (At & { type: "run.cancelled"; reason: "cancel" | "deadline" })
	/**
	 * `text` is the finish text shown to the user (the model's answer); scored against the case's
	 * `answerIncludes`. Required for `finish` when the case asks for information.
	 */
	| (At & { type: "step.final"; kind: FinalKind; text?: string });

export type TrialTranscript = {
	trialId: string;
	caseId: string;
	/** The comparison arm, as the host names it. */
	arm: string;
	/**
	 * The trial's base URL, with a trailing slash. Dev/holdout: the loopback HTTP base the host serves
	 * `lab/fixtures/` on (`http://127.0.0.1:<port>/`). Live: the case's start origin (`https://www.youtube.com/`).
	 * (The field keeps its name; it is the base for every split.) Scheme, host, port and path prefix all count:
	 * a URL on another origin is out of scope, except the other origins a live case allows. URLs are resolved
	 * against it.
	 */
	fixtureBaseUrl: string;
	/** ISO 8601. */
	startedAt: string;
	timings: {
		/** Cold start of the platform session; null when it was already connected. */
		adapterOpenMs: number | null;
		/** First model call to final step, without the cold start. */
		totalMs: number;
	};
	events: TranscriptEvent[];
};
