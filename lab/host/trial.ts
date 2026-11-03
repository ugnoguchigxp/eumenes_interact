import type { Database } from "bun:sqlite";
import type {
	AdapterCommand,
	DeclaredEffect,
	InferenceOutcome,
	OperationResult,
	RunStatus,
} from "eumenes-interact";
import type { CaseDef } from "../cases/schema.ts";
import { scoreTrial, type TrialScore } from "../scorer/score.ts";
import type {
	FinalKind,
	ModelCallOutcome,
	TranscriptEvent,
	TrialTranscript,
} from "../scorer/transcript.ts";
import { finishTrial } from "./store.ts";
import type { InferenceInfo } from "./types.ts";

/**
 * Records one trial as the scorer's `TrialTranscript` (lab/cases/README.md "ホストが記録に入れること"):
 * facts only, in the order they happened, with `at` in milliseconds since the trial started. Observation
 * bodies, model output and typed values granted by the user never enter it.
 */
export class TrialRecorder {
	readonly events: TranscriptEvent[] = [];
	private readonly origin: number;
	private firstCallAt: number | null = null;
	private lastAt = 0;
	adapterOpenMs: number | null = null;

	/**
	 * `scrub`: a real site's page text stays out of the record (plan.md §14). Titles and element names are
	 * page text; URLs, refs and counts are what the scorer reads.
	 */
	constructor(
		private readonly now: () => number,
		private readonly scrub = false,
		readonly startedAt: string = new Date(now()).toISOString(),
	) {
		this.origin = now();
	}

	private at(): number {
		this.lastAt = Math.max(0, this.now() - this.origin);
		return this.lastAt;
	}

	modelCall(
		startedAtMs: number,
		outcome: InferenceOutcome | "error",
		durationMs: number,
	) {
		const at = this.at();
		this.firstCallAt ??= Math.max(0, startedAtMs - this.origin);
		const kind: ModelCallOutcome =
			outcome === "error"
				? "error"
				: outcome.kind === "text"
					? "ok"
					: outcome.kind;
		const usage =
			outcome === "error"
				? { inputTokens: null, outputTokens: null }
				: outcome.usage;
		this.events.push({
			type: "model.call",
			at,
			durationMs,
			outcome: kind,
			tokens: { input: usage.inputTokens, output: usage.outputTokens },
		});
	}

	parse(accepted: boolean, reason?: string) {
		this.events.push({
			type: "step.parse",
			at: this.at(),
			accepted,
			...(reason === undefined ? {} : { reason }),
		});
	}

	observation(o: {
		observationRef: string;
		url?: string;
		title?: string;
		refCount: number;
	}) {
		this.events.push({
			type: "observation",
			at: this.at(),
			observationRef: o.observationRef,
			url: o.url ?? null,
			title: this.scrub ? null : (o.title ?? null),
			refCount: o.refCount,
		});
	}

	requested(o: {
		operationId: string;
		command: AdapterCommand;
		declaredEffect: DeclaredEffect;
		requiresApproval: boolean;
		retryOf?: string;
	}) {
		this.events.push({ type: "operation.requested", at: this.at(), ...o });
	}

	dispatched(operationId: string) {
		this.events.push({
			type: "operation.dispatched",
			at: this.at(),
			operationId,
		});
	}

	result(
		operationId: string,
		result: Pick<OperationResult, "status" | "code" | "url" | "title">,
		adopted: boolean,
	) {
		this.events.push({
			type: "operation.result",
			at: this.at(),
			operationId,
			status: result.status,
			...(result.code === undefined ? {} : { code: result.code }),
			...(result.url === undefined ? {} : { url: result.url }),
			...(result.title === undefined || this.scrub
				? {}
				: { title: result.title }),
			adopted,
		});
	}

	approvalRequested(approvalId: string, operationId: string) {
		this.events.push({
			type: "approval.requested",
			at: this.at(),
			approvalId,
			operationId,
		});
	}

	approvalAnswered(approvalId: string, decision: "grant" | "deny") {
		this.events.push({
			type: "approval.answered",
			at: this.at(),
			approvalId,
			decision,
		});
	}

	cancelled(reason: "cancel" | "deadline") {
		this.events.push({ type: "run.cancelled", at: this.at(), reason });
	}

	/** `text` is the finish or clarify text the model wrote (for answer checks); other kinds have none. */
	final(kind: FinalKind, text?: string) {
		this.events.push({
			type: "step.final",
			at: this.at(),
			kind,
			...(text === undefined ? {} : { text }),
		});
	}

	build(input: {
		trialId: string;
		caseId: string;
		arm: string;
		fixtureBaseUrl: string;
	}): TrialTranscript {
		return {
			...input,
			startedAt: this.startedAt,
			timings: {
				adapterOpenMs: this.adapterOpenMs,
				totalMs:
					this.firstCallAt === null
						? 0
						: Math.max(0, this.lastAt - this.firstCallAt),
			},
			events: this.events,
		};
	}
}

/** Scores the finished transcript and stores both. The score never goes back to the run. */
export function scoreAndStore(
	db: Database,
	def: CaseDef,
	transcript: TrialTranscript,
	end: {
		runStatus: RunStatus;
		stop: unknown;
		inference: InferenceInfo;
		nowIso: string;
	},
): TrialScore {
	const score = scoreTrial(def, transcript);
	finishTrial(db, transcript.trialId, { ...end, transcript, score });
	return score;
}
