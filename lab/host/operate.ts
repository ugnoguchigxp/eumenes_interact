import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
	allowedOriginSchema,
	originAllowed,
	type ArmId,
	type PlatformAdapter,
	type RunStatus,
} from "eumenes-interact";
import { getRun } from "eumenes-interact/sqlite";
import { createSession, type BrowserOptions } from "../cli/session.ts";
import {
	estimateClaudeCostUsd,
	type ClaudeEffort,
} from "../inference/index.ts";
import type { TranscriptEvent } from "../scorer/transcript.ts";
import {
	CliApprover,
	StopApprover,
	type ApprovalPrompt,
	type Approver,
} from "./approval.ts";
import {
	claudeSettings,
	ensureClaudeCredential,
	startClaude,
	type ClaudeSession,
} from "./claude.ts";
import { RunControl } from "./control.ts";
import { DEFAULT_DB_PATH, openLabDb } from "./db.ts";
import { larmFactory } from "./larm.ts";
import { acquireRunLock } from "./lock.ts";
import { createPinoLogger, type LabLogger } from "./log.ts";
import {
	DEFAULT_OBSERVATIONS_DIR,
	createObservationSink,
	pruneObservations,
} from "./observations.ts";
import { DEFAULT_CAPTURES_DIR, resolveCaptureDir } from "./parts/capture.ts";
import { reconcileOnStartup } from "./reconcile.ts";
import { MAX_MODEL_CALLS, LAB_OWNER, runTrial } from "./run.ts";
import { createExperiment } from "./store.ts";
import {
	OPERATE_CASE_PREFIX,
	type InferenceInfo,
	type TrialCase,
} from "./types.ts";
import { collectVersions, packageCommit } from "./versions.ts";

/**
 * A free-form request run by Arm 0 with a real model on a live site (plan.md §13.1, the minimal contract:
 * start, status, cancel; continue comes later). `startOperate` returns at once with the run's id and a handle;
 * the run is the lab's own trial machinery with an ad-hoc live case, so the URL policy (the allowed origins,
 * and no loopback or private host), the approver, the single-runner lock and the restart reconciliation are
 * those of `run`. A transcript and the run are stored; nothing is scored, since nothing is expected.
 */

export type OperateOptions = {
	request: string;
	startUrl: string;
	/** `https://host[:port]` or `https://*.domain`; the start URL's origin must be allowed by them. */
	allowedOrigins: string[];
	inference: "claude" | "larm";
	/** `claude` only; default `claude-haiku-5-5`. */
	model?: string;
	/** `claude` only; default `low`. */
	effort?: ClaudeEffort;
	/** `claude` only: the output bound of one call, recorded with the run's conditions. */
	maxTokens?: number;
	/**
	 * `arm1` (default): the model composes registered parts (plan.md §6.4), the way to read, search, fill forms
	 * and take screenshots. `arm0`: Eumenes' page operator port, the baseline. Arm 1 needs `claude`.
	 */
	arm?: ArmId;
	/**
	 * Arm 1: an existing absolute directory the screenshots go to (the caller chooses it; the model never does).
	 * Absent: `lab/data/captures/<runId>/`, kept at most 7 days.
	 */
	captureDir?: string;
	/** At most 12 (Arm 0's limit); default 12. */
	maxModelCalls?: number;
	headed?: boolean;
	/** `stop` never grants an approval and ends the run as `needs_input`; `cli` asks on the terminal. */
	approver: "stop" | "cli";
	/** Keeps every observation under `lab/data/observations/<runId>/` for at most 7 days (plan.md §14). */
	keepObservations?: boolean;
	dbPath?: string;
};

export type OperateSnapshot = {
	runId: string;
	status: "starting" | RunStatus;
	startedAt: string;
	finishedAt?: string;
	final?: {
		kind: "finish" | "clarify" | "stop" | "failed" | "stopped";
		text?: string;
		code?: string;
	};
	finalUrl?: string;
	modelCalls: number;
	operations: number;
	/** The arm the run used. */
	arm?: ArmId;
	/** Arm 1: the parts called, in order, each with how it ended unless it completed. */
	parts?: readonly string[];
	/** Where the screenshots are (absolute); absent for Arm 0. */
	captureDir?: string;
	/** The files saved there, by the host's names (never a path). */
	captures?: readonly string[];
	/** Null when a call did not report it (unknown, never 0). */
	tokens: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
	};
	/** An estimate from list prices, not a bill; null when the model is unknown or a call reported no tokens. */
	costUsdEstimate: number | null;
	/** What stopped the run for approval: the operation it would have done. */
	approval?: { action: string; element?: string; url?: string };
	/** What answered, frozen for the run. */
	inference?: InferenceInfo;
};

export type OperateHandle = {
	runId: string;
	snapshot(): OperateSnapshot;
	cancel(): void;
	done: Promise<OperateSnapshot>;
};

/** Seams for tests: a fake browser, a fake model, and where the run's records go. */
export type OperateDeps = {
	createSession?: (
		options: BrowserOptions,
		logger: LabLogger,
	) => Promise<{ adapter: PlatformAdapter; dispose(): Promise<void> }>;
	inference?: () => Pick<ClaudeSession, "port" | "info" | "dispose">;
	/** The credential check; default: `ensureClaudeCredential` (the environment, then `<repo>/.env`). */
	ensureCredential?: () => void;
	logger?: LabLogger;
	now?: () => number;
	/** The repository's commit (null when unknown); default: read from git. */
	commit?: string | null;
	/** Where kept observations go. */
	observationsDir?: string;
	/** Where the default capture directories are made; default `lab/data/captures`. */
	capturesRoot?: string;
};

const MAX_REQUEST_CHARS = 8000;

/** Runs one cleanup step (sync or async); a failure of it is not allowed to stop the next one. */
async function attempt(step: () => unknown): Promise<void> {
	try {
		await step();
	} catch {
		// Cleanup only: the run's own outcome is already decided.
	}
}

/** Everything about the request that can be wrong, before anything is opened or locked. */
export function validateOperate(o: OperateOptions): {
	maxModelCalls: number;
	arm: ArmId;
	captureDir: string | undefined;
} {
	const arm = o.arm ?? "arm1";
	if (arm !== "arm1") throw new Error("invalid_arm");
	if (arm === "arm1" && o.inference === "larm")
		throw new Error("arm1_needs_structured_output (use claude)");
	const captureDir =
		o.captureDir === undefined ? undefined : resolveCaptureDir(o.captureDir);
	if (o.request.trim() === "" || o.request.length > MAX_REQUEST_CHARS)
		throw new Error("invalid_request");
	if (o.allowedOrigins.length === 0)
		throw new Error("allowed_origins_required");
	for (const origin of o.allowedOrigins)
		if (!allowedOriginSchema.safeParse(origin).success)
			throw new Error("invalid_allowed_origin");
	let start: URL;
	try {
		start = new URL(o.startUrl);
	} catch {
		throw new Error("invalid_start_url");
	}
	if (start.protocol !== "https:" || start.username || start.password)
		throw new Error("invalid_start_url");
	if (!originAllowed(o.allowedOrigins, start.origin))
		throw new Error("start_origin_not_allowed");
	const max = o.maxModelCalls ?? MAX_MODEL_CALLS;
	if (!Number.isInteger(max) || max < 1 || max > MAX_MODEL_CALLS)
		throw new Error(`invalid_max_calls (1 to ${MAX_MODEL_CALLS})`);
	return { maxModelCalls: max, arm, captureDir };
}

/** Token sums where one unknown call makes the sum unknown. */
class Sum {
	private total: number | null = 0;
	add(value: number | null | undefined) {
		if (this.total === null) return;
		this.total =
			value === null || value === undefined ? null : this.total + value;
	}
	get value() {
		return this.total;
	}
}

export function startOperate(
	o: OperateOptions,
	deps: OperateDeps = {},
): OperateHandle {
	const { maxModelCalls, arm, captureDir } = validateOperate(o);
	const capturesRoot = deps.capturesRoot ?? DEFAULT_CAPTURES_DIR;
	// Frozen for the run, and a missing key is found before a lock is taken or a browser opened.
	const claude = o.inference === "claude" ? claudeSettings(o) : null;
	if (claude && !deps.inference)
		(deps.ensureCredential ?? ensureClaudeCredential)();
	const dbPath = o.dbPath ?? DEFAULT_DB_PATH;
	// Taken before the database is touched and held to the end: reconciliation is only right when no other
	// runner is alive.
	const lock = acquireRunLock(`${dbPath}.run.lock`);
	let db: Database;
	let logger: LabLogger;
	try {
		db = openLabDb(dbPath);
		logger = deps.logger ?? createPinoLogger();
		reconcileOnStartup(db, LAB_OWNER, logger);
	} catch (error) {
		lock.release();
		throw error;
	}
	const now = deps.now ?? Date.now;
	const runId = randomUUID();
	const startedAt = new Date(now()).toISOString();
	const control = new RunControl();
	let status: "starting" | RunStatus = "starting";
	let finishedAt: string | undefined;
	let finalUrl: string | undefined;
	let final: OperateSnapshot["final"];
	let operations = 0;
	let modelCalls = 0;
	const parts: string[] = [];
	const captures: string[] = [];
	let approval: OperateSnapshot["approval"];
	let inferenceInfo: InferenceInfo | undefined;
	const tokens = {
		input: new Sum(),
		output: new Sum(),
		cacheRead: new Sum(),
		cacheWrite: new Sum(),
	};
	const cost = new Sum();

	const onEvent = (e: TranscriptEvent) => {
		switch (e.type) {
			case "model.call":
				modelCalls++;
				tokens.input.add(e.tokens.input);
				tokens.output.add(e.tokens.output);
				tokens.cacheRead.add(e.tokens.cacheRead);
				tokens.cacheWrite.add(e.tokens.cacheWrite);
				cost.add(
					claude
						? estimateClaudeCostUsd(claude.model, {
								inputTokens: e.tokens.input,
								outputTokens: e.tokens.output,
								cacheReadInputTokens: e.tokens.cacheRead ?? null,
								cacheCreationInputTokens: e.tokens.cacheWrite ?? null,
							})
						: null,
				);
				return;
			case "operation.dispatched":
				operations++;
				return;
			case "observation":
				if (e.url !== null) finalUrl = e.url;
				return;
			case "operation.result":
				if (e.url !== undefined) finalUrl = e.url;
				return;
			case "part.result":
				parts.push(
					e.status === "completed" ? e.part : `${e.part}(${e.status})`,
				);
				return;
			case "capture.saved":
				captures.push(e.fileName);
				return;
			case "step.final":
				final = {
					kind: e.kind,
					...(e.text === undefined ? {} : { text: e.text }),
				};
				return;
			default:
		}
	};

	let closed = false;
	const snapshot = (): OperateSnapshot => {
		// The run row is the truth while the run is going; the connection is closed after the end.
		if (!closed) {
			const run = getRun(db, LAB_OWNER, runId);
			if (run) status = run.status;
		}
		return {
			runId,
			arm,
			status,
			startedAt,
			...(finishedAt === undefined ? {} : { finishedAt }),
			...(final ? { final } : {}),
			...(finalUrl === undefined ? {} : { finalUrl }),
			modelCalls,
			operations,
			parts: [...parts],
			...(arm === "arm1"
				? { captureDir: captureDir ?? join(capturesRoot, runId) }
				: {}),
			captures: [...captures],
			tokens: {
				input: tokens.input.value,
				output: tokens.output.value,
				cacheRead: tokens.cacheRead.value,
				cacheWrite: tokens.cacheWrite.value,
			},
			costUsdEstimate: claude ? cost.value : null,
			...(approval ? { approval } : {}),
			...(inferenceInfo ? { inference: inferenceInfo } : {}),
		};
	};

	const inner: Approver =
		o.approver === "cli" ? new CliApprover() : new StopApprover();
	const approver: Approver = {
		decide: (prompt: ApprovalPrompt, signal) => {
			approval = {
				action: prompt.action,
				element: prompt.element,
				url: prompt.page,
			};
			return inner.decide(prompt, signal);
		},
	};

	const done = (async (): Promise<OperateSnapshot> => {
		let session: Awaited<
			ReturnType<NonNullable<OperateDeps["createSession"]>>
		> | null = null;
		let inference: Pick<ClaudeSession, "port" | "info" | "dispose"> | null =
			null;
		try {
			const caseId = `${OPERATE_CASE_PREFIX}${runId}`;
			createExperiment(db, {
				id: caseId,
				name: "operate",
				caseIds: [caseId],
				// The request is the user's own text: only a digest of it is kept.
				caseDigest: createHash("sha256").update(o.request).digest("hex"),
				includesHoldout: false,
				includesLive: true,
				repetitions: 1,
				arms: [arm],
				budget: {
					maxModelCalls,
					inference: { kind: o.inference, ...claude },
				},
				inferenceKind: o.inference,
				nowIso: startedAt,
			});
			await pruneObservations(
				deps.observationsDir ?? DEFAULT_OBSERVATIONS_DIR,
				now(),
			);
			await pruneObservations(capturesRoot, now());
			inference =
				deps.inference?.() ??
				(claude
					? startClaude(claude, logger, runId)
					: larmFactory(db, logger)(runId));
			inferenceInfo = inference.info();
			session = await (deps.createSession ?? createSession)(
				{ headed: o.headed === true },
				logger,
			);
			const def: TrialCase = {
				id: caseId,
				split: "live",
				category: "live",
				variant: "live",
				note: "free-form request (operate)",
				request: o.request,
				start: o.startUrl,
				allowedOrigins: o.allowedOrigins,
				budget: { maxModelCalls },
				approvalScript: { decision: "deny" },
			};
			const result = await runTrial({
				db,
				def,
				arm,
				experimentId: caseId,
				repetition: 1,
				orderIndex: 0,
				adapter: session.adapter,
				inference: inference.port,
				inferenceInfo: inference.info,
				approver,
				logger,
				versions: collectVersions({
					browser: {
						channel: null,
						customExecutable: false,
						headless: o.headed !== true,
					},
					commit: deps.commit === undefined ? packageCommit() : deps.commit,
				}),
				runId,
				// The run's id is the trial's too, so kept observations are filed under the id the caller has.
				trialId: runId,
				onEvent,
				control,
				...(captureDir ? { captureDir } : {}),
				captureRoot: capturesRoot,
				...(o.keepObservations
					? {
							observationSink: createObservationSink(
								deps.observationsDir ?? DEFAULT_OBSERVATIONS_DIR,
							),
						}
					: {}),
				...(deps.now ? { now: deps.now } : {}),
			});
			status = result.status;
			if (final && result.code) final = { ...final, code: result.code };
			else if (!final && result.code && result.status !== "cancelled")
				final = { kind: "failed", code: result.code };
		} catch (error) {
			// An unexpected failure is a failed run with a fixed code; the details are in the logger's codes.
			status = "failed";
			final = {
				kind: "failed",
				code:
					error instanceof Error
						? error.message.split(":")[0]!.slice(0, 64)
						: "host_error",
			};
		}
		finishedAt = new Date(now()).toISOString();
		// Each cleanup runs whatever the one before it did: a failing dispose must not leave the lock held or the
		// database open, and what the run came to is not changed by it.
		await attempt(() => inference?.dispose());
		await attempt(() => session?.dispose());
		const last = snapshot();
		closed = true;
		await attempt(() => {
			if (!deps.logger) logger.close();
		});
		await attempt(() => db.close());
		await attempt(() => lock.release());
		return last;
	})();

	return { runId, snapshot, cancel: () => control.cancel("cancel"), done };
}
