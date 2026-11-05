import type { Database } from "bun:sqlite";
import type {
	AdapterCommand,
	DeclaredEffect,
	InferenceOutcome,
	InferenceUsage,
	OperationResult,
	PartStatus,
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
import type { InferenceInfo, TrialCase } from "./types.ts";

/**
 * Records one trial as the scorer's `TrialTranscript` (lab/cases/README.md "ホストが記録に入れること"):
 * facts only, in the order they happened, with `at` in milliseconds since the trial started. Observation
 * bodies, model output and typed values granted by the user never enter it.
 */
export class TrialRecorder {
	readonly events: TranscriptEvent[] = [];
	/** Called with every event as it is recorded (a progress view); a failing listener changes nothing. */
	onEvent: ((event: TranscriptEvent) => void) | null = null;
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

	/** `stored` is what the record keeps; the listener may be given the event as it really was. */
	private add(event: TranscriptEvent, seen: TranscriptEvent = event) {
		this.events.push(event);
		try {
			this.onEvent?.(seen);
		} catch {
			// A progress view must not change the record.
		}
	}

	private at(): number {
		this.lastAt = Math.max(0, this.now() - this.origin);
		return this.lastAt;
	}

	modelCall(
		startedAtMs: number,
		outcome: InferenceOutcome | "error",
		durationMs: number,
		purpose?: "completion_review",
	) {
		const at = this.at();
		this.firstCallAt ??= Math.max(0, startedAtMs - this.origin);
		const kind: ModelCallOutcome =
			outcome === "error"
				? "error"
				: outcome.kind === "text"
					? "ok"
					: outcome.kind;
		const usage: InferenceUsage =
			outcome === "error"
				? { inputTokens: null, outputTokens: null }
				: outcome.usage;
		this.add({
			type: "model.call",
			...(purpose ? { purpose } : {}),
			...(outcome !== "error" && outcome.metadata
				? { inference: outcome.metadata }
				: {}),
			at,
			durationMs,
			outcome: kind,
			tokens: {
				input: usage.inputTokens,
				output: usage.outputTokens,
				cacheRead: usage.cacheReadInputTokens ?? null,
				cacheWrite: usage.cacheCreationInputTokens ?? null,
			},
		});
	}

	parse(accepted: boolean, reason?: string) {
		this.add({
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
		bodyBytes?: number;
		shapedBytes?: number;
	}) {
		this.add({
			type: "observation",
			at: this.at(),
			observationRef: o.observationRef,
			url: o.url ?? null,
			title: this.scrub ? null : (o.title ?? null),
			refCount: o.refCount,
			...(o.bodyBytes === undefined ? {} : { bodyBytes: o.bodyBytes }),
			...(o.shapedBytes === undefined ? {} : { shapedBytes: o.shapedBytes }),
		});
	}

	requested(o: {
		operationId: string;
		command: AdapterCommand;
		declaredEffect: DeclaredEffect;
		requiresApproval: boolean;
		retryOf?: string;
	}) {
		this.add({ type: "operation.requested", at: this.at(), ...o });
	}

	dispatched(operationId: string) {
		this.add({
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
		this.add({
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
		this.add({
			type: "approval.requested",
			at: this.at(),
			approvalId,
			operationId,
		});
	}

	approvalAnswered(approvalId: string, decision: "grant" | "deny") {
		this.add({
			type: "approval.answered",
			at: this.at(),
			approvalId,
			decision,
		});
	}

	/** Arm 1: a part the model called. Argument names only: the values are the user's or the page's. */
	partCall(part: string, args: readonly string[]) {
		this.add({ type: "part.call", at: this.at(), part, args: [...args] });
	}

	/** Arm 1: how the part ended. `code` is the fixed classification when it did not complete. */
	partResult(part: string, status: PartStatus, code?: string) {
		this.add({
			type: "part.result",
			at: this.at(),
			part,
			status,
			...(code === undefined ? {} : { code }),
		});
	}

	/** A screenshot saved to the run's capture directory. The file name is the host's; no path, no image. */
	captureSaved(saved: {
		captureId: string;
		fileName: string;
		width: number;
		height: number;
		bytes: number;
		mediaType: "image/png" | "image/jpeg";
		range: "viewport" | "full" | "item";
		target?: { role: string; nameHash: string };
	}) {
		this.add({ type: "capture.saved", at: this.at(), ...saved });
	}

	cancelled(reason: "cancel" | "deadline") {
		this.add({ type: "run.cancelled", at: this.at(), reason });
	}

	/**
	 * `text` is the finish or clarify text the model wrote (for answer checks); other kinds have none. On a real
	 * site without kept observations the text summarises page content, so the record keeps its length only
	 * (plan.md §14); a caller listening through `onEvent` still sees the text as it was.
	 */
	/** The last finish or clarify text as written, kept in memory only: the answer check reads it before the scrub. */
	finalText: string | undefined;

	final(kind: FinalKind, text?: string) {
		this.finalText = text;
		const at = this.at();
		const seen: TranscriptEvent = {
			type: "step.final",
			at,
			kind,
			...(text === undefined ? {} : { text }),
		};
		this.add(
			this.scrub && text !== undefined
				? { type: "step.final", at, kind, textLength: text.length }
				: seen,
			seen,
		);
	}

	build(input: {
		trialId: string;
		caseId: string;
		arm: string;
		fixtureBaseUrl: string;
		/** Where this run's screenshots are (absolute); in the transcript only, never in a log. */
		captureDir?: string;
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

/** What a free-form request is scored against: nothing is expected, so only the counters mean anything. */
const NEUTRAL: CaseDef["expect"] = {
	kind: "clarify",
	effectful: [],
	forbidden: [],
	wrongTargets: [],
	approval: "none",
};

/**
 * Scores the finished transcript and stores both. The score never goes back to the run. A trial without
 * `expect` (free-form request) is stored unscored: its counters are returned for the caller's own use, and
 * `score_json` stays empty so no one reads a success into it.
 */
export function scoreAndStore(
	db: Database,
	def: TrialCase,
	transcript: TrialTranscript,
	end: {
		runStatus: RunStatus;
		stop: unknown;
		inference: InferenceInfo;
		nowIso: string;
		/** The unscrubbed final text (a live run's record keeps only its length); never stored. */
		finalText?: string | undefined;
	},
): { score: TrialScore; scored: boolean } {
	const scored = def.expect !== undefined;
	const score = scoreTrial(
		{ ...def, expect: def.expect ?? NEUTRAL } as CaseDef,
		transcript,
		end.finalText === undefined ? {} : { finalText: end.finalText },
	);
	const { finalText: _text, ...stored } = end;
	finishTrial(db, transcript.trialId, {
		...stored,
		transcript,
		score: scored ? score : null,
	});
	return { score, scored };
}
