import type { ObservationEnvelope, RawObservation } from "./observation.ts";
import type { PartCall, PartResult } from "./parts.ts";
import type {
	AdapterCommand,
	DeclaredEffect,
	OperationResult,
} from "./operation.ts";

/**
 * The one-step core shared by the lab host and Eumenes' runner (plan.md §4). Pure: no IO, no clock
 * (the host passes `nowMs`), no randomness. The host calls inference, enforces budget/deadline/cancel/
 * approval, sends operations and stores state. `CoreState` is JSON the host stores and restores as an
 * opaque value.
 *
 * The functions implementing these types live in `src/core/` and are re-exported from the package root:
 *   startRun(input: StartRunInput): CoreState
 *   prepareStep(state: CoreState): PreparedStep
 *   parseStep(state: CoreState, raw: string): { state: CoreState; step: ParsedStep }
 *   applyResult(state: CoreState, outcome: HostOutcome): { state: CoreState; step: AppliedStep }
 *   shapeObservation(arm: ArmId, raw: RawObservation): ShapedObservation
 *   parseCoreState(value: unknown): CoreState | null
 */

/** `arm0`: Eumenes' page operator port (baseline). `arm1`: registered parts (plan.md §6.4). */
export type ArmId = "arm0" | "arm1";

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

/** Opaque to hosts. Versioned so a host can refuse a state another core version wrote. */
export type CoreState = {
	readonly formatVersion: 1;
	readonly arm: ArmId;
	readonly [key: string]: unknown;
};

/** Frozen when the run starts (plan.md §9); a later revision never changes a running run. */
export type RunPolicy = {
	maxModelCalls: number;
	/** Retries after a tool refusal, per tool id; `default` for the rest. */
	retries: Readonly<Record<string, number>>;
};

export type StartRunInput = {
	arm: ArmId;
	/** The user's request, original text. */
	request: string;
	/** The request as a delegating agent handed it over (kept only when it differs). */
	brief?: string;
	/** Enclosed reference data (target URL, known tabs…); data, never instructions. */
	reference?: Readonly<Record<string, unknown>>;
	policy: RunPolicy;
	nowMs: number;
	/**
	 * Tool ids offered this run, filtered by the host from permission and the adapter catalog.
	 * Absent: every tool of the arm. Unknown ids are an error.
	 */
	tools?: readonly string[];
};

export type PreparedStep = {
	messages: ChatMessage[];
	callsLeft: number;
	/**
	 * When set, the inference port must constrain the output to this JSON Schema (Claude structured
	 * outputs). Arm 1 sets it; Arm 0 does not (Eumenes sends no output control).
	 */
	outputSchema?: Record<string, unknown>;
};

/** Why `parseStep` rejected an output (plan.md §4, §11 "出力の不正"; counted per call). */
export type ParseRejectionCode =
	| "unparsable_json"
	| "schema_violation"
	| "action_fields"
	| "unknown_tool"
	/** Arm 1: an item id or result id the core never showed (or one of an older page). */
	| "unknown_reference"
	| "invoke_on_last_call";

/** Facts about one parsed call, for trial records. Never carries the raw output. */
export type ParseRecord = {
	accepted: boolean;
	rejection?: ParseRejectionCode;
};

/** Where an operation's input value came from (Arm 0 `type`): checked by the host, never assumed. */
export type InputProvenance =
	| { kind: "request_quote"; quote: string }
	| { kind: "grant"; inputValueRef: string };

/** What the host must do for a validated tool call. Tab refs are the host's stable refs. */
export type HostCall =
	/** Arm 1: run one registered part (plan.md §6.4); the host's part executor implements it. */
	| { kind: "part"; part: PartCall }
	| { kind: "observe"; tabRef?: string }
	| { kind: "tabs.list" }
	| { kind: "tabs.select"; tabRef: string }
	| { kind: "tabs.new"; url: string }
	| {
			kind: "operate";
			tabRef?: string;
			observationRef?: string;
			command: AdapterCommand;
			declaredEffect: DeclaredEffect;
			inputProvenance?: InputProvenance;
	  };

export type CoreFailureCode =
	"invalid_contract" | "turn_limit" | "invoke_on_last_call" | "tool_refused";

export type ParsedStep =
	/** Execute `call`, then pass the outcome to `applyResult`. */
	| { kind: "call"; tool: string; call: HostCall; callsLeft: number }
	/**
	 * Nothing to execute: the core recorded a repair notice or a local tool refusal (invalid arguments,
	 * a ref not in the latest observation…) in the state. Call inference again.
	 */
	| { kind: "continue"; callsLeft: number }
	| { kind: "finish"; text: string; refs: string[] }
	| { kind: "clarify"; text: string }
	/**
	 * The run stops before anything is sent and asks the user (Arm 0: `input_value_unconfirmed`, a value
	 * the request does not show). The host moves the run to `needs_input` and stores the approvals; an
	 * approved value comes back in the next run's `reference.approved`.
	 */
	| {
			kind: "stop";
			code: string;
			text: string;
			approvals: InputValueApprovalRequest[];
	  }
	| { kind: "failed"; code: CoreFailureCode };

/** An input value the user must allow before it is typed (Eumenes `InputValueApproval`). */
export type InputValueApprovalRequest = {
	kind: "input_value";
	value: string;
	origin: string;
	purpose: string;
};

export type TabView = {
	tabRef: string;
	url?: string;
	title?: string;
	current: boolean;
};

/** What the host learned by executing a `HostCall`. */
export type HostOutcome =
	/** Arm 1: what a part did. A part stopped for approval comes back as `stop`. */
	| { kind: "part"; result: PartResult }
	| { kind: "observation"; observation: ObservationEnvelope }
	| {
			kind: "operation";
			result: OperationResult;
			/** The observation the host took after the operation, when it took one. */
			observation?: ObservationEnvelope;
	  }
	| { kind: "tabs"; tabs: TabView[] }
	/** The host refused the call; nothing reached the page. `retryable: false` ends retries of this tool. */
	| {
			kind: "refused";
			code: string;
			retryable: boolean;
			detail?: Readonly<Record<string, string | number | boolean>>;
	  }
	/** The run stops and asks the user (approval, input value…); nothing reached the page. */
	| { kind: "stop"; code: string; text: string };

export type AppliedStep =
	| { kind: "continue"; callsLeft: number }
	| { kind: "stopped"; code: string; text: string }
	| { kind: "failed"; code: CoreFailureCode };

/** An observation after the arm's shaping; the host wraps it into an `ObservationEnvelope`. */
export type ShapedObservation = {
	body: string;
	truncated: boolean;
	truncationReasons: string[];
	refCount: number;
	/** Refs present in `body`; only these are actionable. */
	refs: string[];
};

/** Signature-only declarations the core implements (checked by `src/core` against these). */
export type CoreApi = {
	startRun(input: StartRunInput): CoreState;
	prepareStep(state: CoreState): PreparedStep;
	parseStep(
		state: CoreState,
		raw: string,
	): { state: CoreState; step: ParsedStep; record: ParseRecord };
	applyResult(
		state: CoreState,
		outcome: HostOutcome,
	): { state: CoreState; step: AppliedStep };
	shapeObservation(arm: ArmId, raw: RawObservation): ShapedObservation;
	parseCoreState(value: unknown): CoreState | null;
};
