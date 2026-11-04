import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
	AdapterError,
	applyResult,
	parseStep,
	prepareStep,
	startRun,
	type ArmId,
	type CoreState,
	type InferenceOutcome,
	type InferencePort,
	type PlatformAdapter,
	type RunPolicy,
	type RunStatus,
} from "eumenes-interact";
import {
	createRun,
	getRun,
	isInteractStoreError,
	isTerminalRunStatus,
	saveCoreState,
	transitionRun,
} from "eumenes-interact/sqlite";
import type { TrialScore } from "../scorer/score.ts";
import type { TranscriptEvent, TrialTranscript } from "../scorer/transcript.ts";
import type { Approver } from "./approval.ts";
import { RunControl } from "./control.ts";
import { write } from "./db.ts";
import { createExecutor } from "./executor.ts";
import { CaptureStore } from "./parts/capture.ts";
import { labEventsPort, labKnowledgePort } from "./parts/ports.ts";
import { createPartExecutor } from "./parts/executor.ts";
import { InputGrants } from "./grants.ts";
import type { LabLogger } from "./log.ts";
import { fixturePolicy, originPolicy } from "./policy.ts";
import type { ObservationSink } from "./observations.ts";
import { insertTrial, updateTrialVersions } from "./store.ts";
import { TabRegistry } from "./tabs.ts";
import { scoreAndStore, TrialRecorder } from "./trial.ts";
import {
	RunEnd,
	type InferenceInfo,
	type RunEndStatus,
	type TrialCase,
	type TrialVersions,
} from "./types.ts";

/**
 * The run loop of the research host for one case and one arm (plan.md §3.1, §9). Arm 0's constants come from
 * Eumenes' `browser-task-runner.ts` (commit 98b188d2) so a measurement is reproducible there.
 */

export const OUTPUT_TOKENS = 2048;
/** One model call may take this long; a run past its own deadline is stopped by the host. */
export const CALL_MS = 90_000;
export const MIN_CALL_MS = 5_000;
/** A run may make at most this many model calls. */
export const MAX_MODEL_CALLS = 10;

export const LAB_OWNER = "lab";
const ARM1_SKILL_REF = "arm1:parts@1";

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

/** The case's budget as the run's frozen policy. A case past the run limit is refused, not clamped. */
export function runPolicy(def: TrialCase): RunPolicy {
	if (def.budget.maxModelCalls > MAX_MODEL_CALLS)
		throw new Error(`case_budget_exceeds_limit:${def.id}`);
	return { maxModelCalls: def.budget.maxModelCalls, retries: { default: 1 } };
}

export type RunTrialInput = {
	db: Database;
	def: TrialCase;
	arm: ArmId;
	experimentId: string;
	repetition: number;
	orderIndex: number;
	adapter: PlatformAdapter;
	inference: InferencePort;
	inferenceInfo: () => InferenceInfo;
	approver: Approver;
	logger: LabLogger;
	versions: TrialVersions;
	/**
	 * The fixture server's base, ending in `/`; case `start` is relative to it. Not used for a live case:
	 * its base is its start origin, and `def.start` is absolute.
	 */
	fixtureBaseUrl?: string;
	/**
	 * Keeps every observation body (`--keep-observations`). Without it a live run stores none: not in the
	 * transcript, and not in the saved core state, which holds the pages the model read (plan.md §14).
	 */
	observationSink?: ObservationSink;
	owner?: string;
	/** Fixed beforehand when the caller must know the run's id before it starts (`operate`). */
	runId?: string;
	/** Likewise for the trial (kept observations are filed under it). */
	trialId?: string;
	/** Every transcript event as it happens (a progress view). */
	onEvent?: (event: TranscriptEvent) => void;
	now?: () => number;
	control?: RunControl;
	/** Defaults to the budget's calls at `CALL_MS` each. */
	deadlineMs?: number;
	/**
	 * Arm 1: an existing absolute directory the run's screenshots go to (the caller chooses it per run; the
	 * model never does). Absent: `<captureRoot>/<runId>/`.
	 */
	captureDir?: string;
	/** Where the default capture directories are made; default `lab/data/captures`. */
	captureRoot?: string;
	/**
	 * Verified results of earlier steps of the same request (a chain): a search term found in one of them is
	 * sourced like one taken from the request itself.
	 */
	sources?: readonly string[];
	/** The chain step's goal: its plain words may join a search (see PartsDeps.goal). */
	goal?: string;
	/**
	 * Leaves the browser open when the trial ends (a chain step whose result is the screen). The caller then
	 * owns the session and closes it.
	 */
	keepSession?: boolean;
	/**
	 * Checked by the host when the model says it is done; a failed check ends the trial as failed with its
	 * code instead of a false success (chain playback steps: `confirmPlayback`).
	 */
	beforeFinish?: () => Promise<{ ok: true } | { ok: false; code: string }>;
};

export type TrialResult = {
	trialId: string;
	runId: string;
	status: RunStatus;
	code: string | null;
	transcript: TrialTranscript;
	/** Counters and, when the case expects something, the verdict. */
	score: TrialScore;
	/** False for a free-form request: `score` then has counters only and nothing was judged. */
	scored: boolean;
	/** Where this run's screenshots are (absolute); the files named by its `capture.saved` events. */
	captureDir: string;
	/** The model's final text, in memory only (never stored for a live run without kept observations). */
	finalText: string;
};

type Ending = {
	status: RunStatus;
	code: string | null;
	stop?: unknown;
};

const endingOf = (status: RunEndStatus, code: string): Ending => ({
	status,
	code,
});

export async function runTrial(input: RunTrialInput): Promise<TrialResult> {
	const { db, def, adapter, logger } = input;
	const now = input.now ?? Date.now;
	const owner = input.owner ?? LAB_OWNER;
	const trialId = input.trialId ?? randomUUID();
	const runId = input.runId ?? randomUUID();
	const sessionId = randomUUID();
	const control = input.control ?? new RunControl();
	const policy = runPolicy(def);
	const arm1 = input.arm === "arm1";
	// A bad capture directory is refused before the run or anything else is created.
	const captures = new CaptureStore({
		runId,
		...(input.captureDir === undefined ? {} : { dir: input.captureDir }),
		...(input.captureRoot === undefined
			? {}
			: { defaultRoot: input.captureRoot }),
	});
	// Where the trial's URLs are resolved from and what it may visit. A live case names its own origins.
	const live = def.split === "live";
	const baseUrl = live ? `${new URL(def.start).origin}/` : input.fixtureBaseUrl;
	if (!baseUrl) throw new Error("fixture_base_url_missing");
	const urlPolicy = live
		? originPolicy(def.allowedOrigins ?? [], def.openWeb === true)
		: fixturePolicy(baseUrl);
	const startUrl = live ? def.start : new URL(def.start, baseUrl).href;
	const nowIso = () => new Date(now()).toISOString();
	const deadlineMs = input.deadlineMs ?? policy.maxModelCalls * CALL_MS;
	const startedAtMs = now();
	const deadlineAtMs = startedAtMs + deadlineMs;
	// A real site without kept observations stores no page-derived text (plan.md §14).
	const scrub = live && !input.observationSink;
	/** What is kept of a stop: the text and approvals go with the page's data, so only their size stays. */
	const stopRecord = (
		code: string,
		text: string,
		approvals: readonly unknown[],
	) =>
		scrub
			? { code, textLength: text.length, approvals: approvals.length }
			: { code, text, approvals };
	const recorder = new TrialRecorder(now, scrub);
	if (input.onEvent) recorder.onEvent = input.onEvent;
	const tabs = new TabRegistry();
	const grants = new InputGrants(now, randomUUID);
	const log = (
		name: Parameters<LabLogger["lab"]>[0],
		fields: { code?: string; count?: number; durationMs?: number } = {},
	) => logger.lab(name, { correlationId: runId, ...fields });

	// Versions, policy and deadline are frozen before anything opens (plan.md §9).
	write(db, () => {
		createRun(db, owner, {
			runId,
			skillRef: ARM1_SKILL_REF,
			skillDigest: "arm1-parts:1",
			catalogRef: `catalog:${adapter.platform}`,
			catalogDigest: `sha256:${sha256(JSON.stringify(adapter.catalog()))}`,
			platform: adapter.platform,
			coreFormatVersion: input.versions.coreFormatVersion,
			policy,
			deadlineAt: new Date(deadlineAtMs).toISOString(),
			nowIso: nowIso(),
		});
		transitionRun(db, owner, runId, "running", { nowIso: nowIso() });
	});
	insertTrial(db, {
		trialId,
		experimentId: input.experimentId,
		caseId: def.id,
		split: def.split,
		arm: input.arm,
		platform: adapter.platform,
		executionMode: "free",
		knowledge: "none",
		repetition: input.repetition,
		orderIndex: input.orderIndex,
		runId,
		startedAt: nowIso(),
		versions: input.versions,
		inference: input.inferenceInfo(),
	});
	log("trial.started");

	/** Cancel and expiry: the run leaves `running` at once, so nothing more can be dispatched. */
	const onAbort = () => {
		const reason = control.reason ?? "cancel";
		recorder.cancelled(reason);
		tabs.invalidateAll();
		try {
			write(db, () =>
				transitionRun(
					db,
					owner,
					runId,
					reason === "deadline" ? "expired" : "cancelled",
					{ nowIso: nowIso(), reason },
				),
			);
		} catch (error) {
			if (!isInteractStoreError(error)) throw error;
		}
		log("run.cancelled", { code: reason });
	};
	control.signal.addEventListener("abort", onAbort, { once: true });
	if (control.signal.aborted) onAbort();
	const timer = setTimeout(() => control.cancel("deadline"), deadlineMs);

	let revision = 0;
	let kept = 0;
	/** The state is stored after every step; a closed run (cancelled meanwhile) keeps what it had. */
	const save = (state: CoreState) => {
		// The state holds the observation bodies the model read: a live run keeps it only when asked to.
		if (live && !input.observationSink) return;
		try {
			revision = write(db, () =>
				saveCoreState(db, owner, runId, {
					state,
					expectedRevision: revision,
					nowIso: nowIso(),
				}),
			);
		} catch (error) {
			if (!(isInteractStoreError(error) && error.code === "run_closed"))
				throw error;
		}
	};

	const cancelEnding = (): Ending => {
		const end = control.ended();
		return endingOf(end.status, end.code);
	};

	async function drive(): Promise<Ending> {
		const opening = now();
		await adapter.open(control.signal);
		recorder.adapterOpenMs = now() - opening;
		updateTrialVersions(db, trialId, {
			...input.versions,
			tool: adapter.toolInfo(),
		});
		const executor = createExecutor({
			db,
			owner,
			runId,
			sessionId,
			adapter,
			policy: urlPolicy,
			tabs,
			grants,
			approver: input.approver,
			recorder,
			logger,
			control,
			now,
			newId: randomUUID,
			request: def.request,
			scrub,
			// Arm 1 reads the whole snapshot (the model sees summaries) and follows its own page's navigation.
			followOwnNavigation: true,
			...(input.observationSink
				? {
						keepObservation: (o) => input.observationSink?.(trialId, ++kept, o),
					}
				: {}),
		});
		const first = await executor.start(startUrl);
		const parts = createPartExecutor({
			knowledge: labKnowledgePort(db, owner),
			executor,
			tabs,
			recorder,
			captures,
			grants,
			request: def.request,
			...(input.sources ? { sources: () => input.sources ?? [] } : {}),
			...(input.goal !== undefined ? { goal: input.goal } : {}),
			events: labEventsPort(logger, runId),
		});
		let state = startRun({
			arm: input.arm,
			request: def.request,
			reference: {
				connection: { connectionId: sessionId, state: "connected" },
				page: parts.begin(first),
			},
			policy,
			nowMs: now(),
		});
		save(state);
		for (;;) {
			if (control.signal.aborted) return cancelEnding();
			const callStarted = now();
			const callMs = Math.min(CALL_MS, deadlineAtMs - callStarted);
			if (callMs < MIN_CALL_MS) {
				control.cancel("deadline");
				return cancelEnding();
			}
			const prepared = prepareStep(state);
			let outcome: InferenceOutcome | "error";
			try {
				outcome = await input.inference.complete({
					messages: prepared.messages,
					maxOutputTokens: OUTPUT_TOKENS,
					...(prepared.outputSchema
						? { outputSchema: prepared.outputSchema }
						: {}),
					signal: AbortSignal.any([
						control.signal,
						AbortSignal.timeout(callMs),
					]),
				});
			} catch {
				// The port promises to classify its failures; one that throws is an error call.
				outcome = "error";
			}
			recorder.modelCall(callStarted, outcome, now() - callStarted);
			log("model.called", {
				code: outcome === "error" ? "error" : outcome.kind,
				durationMs: now() - callStarted,
			});
			if (control.signal.aborted) return cancelEnding();
			// The call timeout and the run deadline can fire together: the deadline is the cause.
			if (
				(outcome === "error" || outcome.kind === "error") &&
				now() >= deadlineAtMs
			) {
				control.cancel("deadline");
				return cancelEnding();
			}
			if (outcome === "error" || outcome.kind !== "text") {
				recorder.final("failed");
				return {
					status: "failed",
					code: `inference_${outcome === "error" ? "error" : outcome.kind}`,
				};
			}
			const parsed = parseStep(state, outcome.text);
			state = parsed.state;
			recorder.parse(parsed.record.accepted, parsed.record.rejection);
			log("step.parsed", {
				code: parsed.record.rejection ?? "accepted",
			});
			save(state);
			const step = parsed.step;
			switch (step.kind) {
				case "continue":
					continue;
				case "finish": {
					const gate = input.beforeFinish
						? await input.beforeFinish()
						: ({ ok: true } as const);
					if (!gate.ok) {
												recorder.final("failed");
						return { status: "failed", code: gate.code };
					}
					recorder.final("finish", step.text);
					return { status: "completed", code: null };
				}
				case "clarify":
					recorder.final("clarify", step.text);
					return { status: "needs_input", code: "clarify" };
				case "stop":
					recorder.final("stopped", step.text);
					return {
						status: "needs_input",
						code: step.code,
						stop: stopRecord(step.code, step.text, step.approvals),
					};
				case "failed":
					recorder.final("failed");
					return { status: "failed", code: step.code };
				case "call": {
					const executed =
						step.call.kind === "part"
							? await parts.run(step.call.part)
							: await executor.execute(step.call);
					if (executed.kind === "end") {
						if (
							executed.status === "cancelled" ||
							executed.status === "expired"
						)
							return cancelEnding();
						recorder.final("failed");
						return endingOf(executed.status, executed.code);
					}
					// A result that arrives after a cancel is never given to the core.
					if (control.signal.aborted) return cancelEnding();
					const applied = applyResult(state, executed.outcome);
					state = applied.state;
					save(state);
					if (applied.step.kind === "continue") continue;
					if (applied.step.kind === "stopped") {
						recorder.final("stopped", applied.step.text);
						return {
							status: "needs_input",
							code: applied.step.code,
							stop: stopRecord(applied.step.code, applied.step.text, []),
						};
					}
					recorder.final("failed");
					return { status: "failed", code: applied.step.code };
				}
			}
		}
	}

	let ending: Ending;
	let unexpected: unknown;
	try {
		ending = await drive();
	} catch (error) {
		// A cancel or deadline while the adapter was opening or working surfaces as an error; the run was
		// already moved by `onAbort`, so it ends as cancelled/expired with no final step.
		if (
			control.signal.aborted &&
			(error instanceof RunEnd || error instanceof AdapterError)
		)
			ending = cancelEnding();
		else if (error instanceof RunEnd) {
			if (error.status === "cancelled" || error.status === "expired")
				ending = cancelEnding();
			else {
				recorder.final("failed");
				ending = endingOf(error.status, error.code);
			}
		} else if (error instanceof AdapterError) {
			recorder.final("failed");
			ending = { status: "failed", code: error.code };
		} else {
			recorder.final("failed");
			unexpected = error;
			ending = { status: "failed", code: "host_error" };
		}
	} finally {
		clearTimeout(timer);
		control.signal.removeEventListener("abort", onAbort);
		try {
			// Only what this host started is stopped; the adapter's close is idempotent.
			if (!input.keepSession) await adapter.close();
		} catch {
			// A failing close must not hide how the run ended.
		}
	}

	// Cancel and expiry already moved the run; any other end moves it now, and a refusal is not hidden.
	write(db, () => {
		const current = getRun(db, owner, runId);
		if (current && !isTerminalRunStatus(current.status))
			transitionRun(db, owner, runId, ending.status, {
				nowIso: nowIso(),
				...(ending.code ? { reason: ending.code } : {}),
			});
	});
	log("run.status", { code: ending.status });
	const transcript = recorder.build({
		trialId,
		caseId: def.id,
		arm: input.arm,
		fixtureBaseUrl: baseUrl,
		...(arm1 ? { captureDir: captures.dir } : {}),
	});
	const { score, scored } = scoreAndStore(db, def, transcript, {
		runStatus: ending.status,
		stop: ending.stop ?? null,
		inference: input.inferenceInfo(),
		nowIso: nowIso(),
		finalText: recorder.finalText,
	});
	log("trial.finished", {
		code: !scored ? "unscored" : score.success ? "success" : "failure",
		count: score.efficiency.modelCalls,
		durationMs: now() - startedAtMs,
	});
	if (unexpected !== undefined) throw unexpected;
	return {
		trialId,
		runId,
		status: ending.status,
		code: ending.code,
		transcript,
		score,
		scored,
		captureDir: captures.dir,
		finalText: recorder.finalText ?? "",
	};
}
