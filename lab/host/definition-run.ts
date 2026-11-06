import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
	AdapterError,
	definitionDigest,
	resolveDefinition,
	type AdapterCommand,
	type DeclaredEffect,
	type DefinitionIssue,
	type ExtractedContent,
	type ObservationEnvelope,
	type PlatformAdapter,
	type PlatformId,
	type ResolvedStep,
	type RunStatus,
	type WorkDefinition,
} from "eumenes-interact";
import {
	createRun,
	getRun,
	isInteractStoreError,
	isTerminalRunStatus,
	recordEvidence,
	registerWorkflowRevision,
	transitionRun,
} from "eumenes-interact/sqlite";
import {
	StopApprover,
	type ApprovalPrompt,
	type Approver,
} from "./approval.ts";
import { lookupObject, resolveObject } from "./candidates.ts";
import { resolveCaptureDir } from "./parts/capture.ts";
import { RunControl } from "./control.ts";
import { write } from "./db.ts";
import { createExecutor, type Executed } from "./executor.ts";
import { InputGrants } from "./grants.ts";
import type { LabLogger } from "./log.ts";
import type { ObservationSink } from "./observations.ts";
import { originPolicy } from "./policy.ts";
import { LAB_OWNER } from "./run.ts";
import { finishDefinitionRun, insertDefinitionRun } from "./store.ts";
import { TabRegistry } from "./tabs.ts";
import { TrialRecorder } from "./trial.ts";
import { Refusal, RunEnd, RunPersistenceError } from "./types.ts";

/**
 * Runs a work definition (plan.md §6) on a platform adapter without a model: the steps in order, each
 * operation through the same gate, ledger and settle as a model's, each target found by the site knowledge
 * against the page as it is now. The definition names no ref; a step whose target is missing or ambiguous
 * stops the run, and nothing is ever approved on the user's behalf unless the caller's approver says so.
 *
 * Privacy (plan.md §14): the inputs are returned to the caller and never stored or logged (the database
 * keeps a digest); extracted text and observations are returned and not stored unless the caller gave an
 * `observationSink`.
 */

const DEFAULT_DEADLINE_MS = 5 * 60_000;

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

/** JSON with sorted keys: the digest of the inputs does not depend on the order they were given in. */
const canonical = (value: Readonly<Record<string, unknown>>) =>
	JSON.stringify(
		Object.fromEntries(
			Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
		),
	);

function originAndPath(raw: string): string {
	try {
		const url = new URL(raw);
		return `${url.origin}${url.pathname}`;
	} catch {
		return "";
	}
}

export type StepStatus =
	| "confirmed"
	| "skipped"
	| "failed"
	| "needs_input"
	| "indeterminate"
	| "cancelled"
	| "expired"
	| "not_run";

export type StepReport = {
	id: string;
	action: string;
	status: StepStatus;
	code?: string;
	skipped?: true;
	/**
	 * For a click or a submitted fill: whether the page's URL differs from before the step. A confirmed
	 * click that changed nothing (a page script handled it) is visible to the caller this way.
	 */
	urlChanged?: boolean;
	/** Milliseconds the step took (a skipped one is about zero). */
	durationMs: number;
	/** `page.observe`: UTF-8 bytes of the snapshot as the platform gave it, and the refs in it. */
	bodyBytes?: number;
	refCount?: number;
	/** `page.extract`: characters of the page's main text before the cap. */
	charCount?: number;
};

type StepDone = {
	status: StepStatus;
	code?: string;
	operationId?: string;
	observationRef?: string;
	/** The URL the step ended on, when the platform said. */
	url?: string;
	urlChanged?: boolean;
	bodyBytes?: number;
	refCount?: number;
	charCount?: number;
};

export type ExtractReport = {
	url: string | null;
	title: string | null;
	text: string;
	charCount: number;
	truncated: boolean;
	root: ExtractedContent["root"];
};

export type DefinitionRunResult = {
	ok: boolean;
	/** The run's status; `rejected` when the definition or the inputs were refused before any run existed. */
	status: RunStatus | "rejected";
	/** Why a run that did not complete stopped (a fixed code). */
	code: string | null;
	definition: { id: string; revision: number; digest: string };
	/** The platform the session was on, and the external tool it reported (null before it opened). */
	platform: PlatformId;
	tool: { name: string; version: string | null } | null;
	inputs: Record<string, string>;
	finalUrl: string | null;
	steps: StepReport[];
	extracts: Record<string, ExtractReport>;
	runId: string | null;
	/** Set when the run stopped for an approval the approver did not give. */
	approval?: Pick<ApprovalPrompt, "action" | "page" | "element" | "summary">;
	/** Set when `status` is `rejected`. */
	issues?: DefinitionIssue[];
	/** The files saved in `captureDir`, by the host's names; empty while no step can capture. */
	captures?: readonly string[];
};

export type RunDefinitionOptions = {
	db: Database;
	definition: WorkDefinition;
	inputs: Record<string, string>;
	/** A fresh session on the platform; this run opens it and always closes it. */
	adapter: PlatformAdapter;
	/** Default: a `StopApprover`, which never grants. */
	approver?: Approver;
	logger: LabLogger;
	owner?: string;
	now?: () => number;
	control?: RunControl;
	deadlineMs?: number;
	/** Keeps every observation and extract (`--keep-observations`); without it a real site's text is kept nowhere. */
	observationSink?: ObservationSink;
	/**
	 * Where screenshots would go: an existing absolute directory, refused before anything starts when it is not
	 * one. A work definition's steps (plan.md §6.1) have no screenshot action yet, so nothing is written here
	 * today; the option is the contract `task run` and the MCP server already pass.
	 */
	captureDir?: string;
};

type Ending = { status: RunStatus; code: string | null };

export async function runDefinition(
	options: RunDefinitionOptions,
): Promise<DefinitionRunResult> {
	const { db, definition, inputs, adapter, logger } = options;
	if (options.captureDir !== undefined) resolveCaptureDir(options.captureDir);
	const now = options.now ?? Date.now;
	const owner = options.owner ?? LAB_OWNER;
	const digest = definitionDigest(definition);
	const meta = { id: definition.id, revision: definition.revision, digest };
	const rejected = (
		code: string,
		issues: DefinitionIssue[],
	): DefinitionRunResult => ({
		ok: false,
		status: "rejected",
		code,
		definition: meta,
		platform: adapter.platform,
		tool: null,
		inputs,
		finalUrl: null,
		steps: [],
		extracts: {},
		runId: null,
		issues,
	});

	const resolved = resolveDefinition(definition, inputs);
	if (!resolved.ok) return rejected("invalid_input", resolved.issues);
	const steps: readonly ResolvedStep[] = resolved.steps;

	const runId = randomUUID();
	const nowIso = () => new Date(now()).toISOString();
	const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
	const sink = options.observationSink;
	try {
		write(db, () => {
			// The published revision is immutable: the same id and revision with other content is a conflict.
			registerWorkflowRevision(db, owner, {
				workflowId: definition.id,
				revision: definition.revision,
				formatVersion: definition.formatVersion,
				digest,
				skillRef: definition.skillRef,
				catalogRef: definition.catalogRef,
				definition: definition as unknown as Record<string, unknown>,
				nowIso: nowIso(),
			});
			createRun(db, owner, {
				runId,
				workflow: { id: definition.id, revision: definition.revision },
				skillRef: definition.skillRef,
				skillDigest: `sha256:${sha256(definition.skillRef)}`,
				catalogRef: definition.catalogRef,
				catalogDigest: `sha256:${sha256(JSON.stringify(adapter.catalog()))}`,
				platform: adapter.platform,
				coreFormatVersion: 1,
				// No model is called.
				policy: { maxModelCalls: 0, retries: {} },
				deadlineAt: new Date(now() + deadlineMs).toISOString(),
				nowIso: nowIso(),
			});
			transitionRun(db, owner, runId, "running", { nowIso: nowIso() });
		});
	} catch (error) {
		if (isInteractStoreError(error) && error.code === "revision_conflict")
			return rejected("definition_revision_conflict", [
				{ path: "revision", code: "revision_conflict" },
			]);
		throw error;
	}
	insertDefinitionRun(db, {
		runId,
		definitionId: definition.id,
		revision: definition.revision,
		digest,
		inputsSha256: sha256(canonical(inputs)),
		platform: adapter.platform,
		startedAt: nowIso(),
	});
	const log = (
		name: Parameters<LabLogger["lab"]>[0],
		fields: { code?: string; count?: number; durationMs?: number } = {},
	) => logger.lab(name, { correlationId: runId, ...fields });
	log("definition.started", { count: steps.length });

	const approver = options.approver ?? new StopApprover();
	const control = options.control ?? new RunControl();
	const tabs = new TabRegistry();
	const grants = new InputGrants(now, randomUUID);
	const recorder = new TrialRecorder(now, true);
	const reports: StepReport[] = steps.map((s) => ({
		id: s.id,
		action: s.action,
		status: "not_run",
		durationMs: 0,
	}));
	const extracts: Record<string, ExtractReport> = {};
	let kept = 0;
	let finalUrl: string | null = null;
	let tool: DefinitionRunResult["tool"] = null;
	let latest: ObservationEnvelope | null = null;

	/** Cancel and expiry: the run leaves `running` at once, so nothing more can be dispatched. */
	const onAbort = () => {
		const reason = control.reason ?? "cancel";
		tabs.invalidateAll();
		try {
			write(db, () =>
				transitionRun(
					db,
					owner,
					runId,
					reason === "deadline" ? "expired" : "cancelled",
					{
						nowIso: nowIso(),
						reason,
					},
				),
			);
		} catch (error) {
			if (!isInteractStoreError(error)) throw error;
		}
	};
	control.signal.addEventListener("abort", onAbort, { once: true });
	if (control.signal.aborted) onAbort();
	const timer = setTimeout(() => control.cancel("deadline"), deadlineMs);

	const executor = createExecutor({
		db,
		owner,
		runId,
		sessionId: randomUUID(),
		adapter,
		policy: originPolicy(definition.allowedOrigins),
		tabs,
		grants,
		approver,
		recorder,
		logger,
		control,
		now,
		newId: randomUUID,
		request: definition.title,
		// No model reads the page: refs are looked up in the whole snapshot.
		// A page may redirect after our own action returned; Arm 0 keeps Eumenes' stricter tab rule.
		followOwnNavigation: true,
		scrub: !sink,
		...(sink ? { keepObservation: (o) => sink(runId, ++kept, o) } : {}),
	});

	const noteUrl = (url: string | undefined) => {
		if (url !== undefined) finalUrl = url;
	};

	/** What a step's execution came to, and the state it leaves behind. */
	function settle(executed: Executed): StepDone {
		if (executed.kind === "end") {
			const status: StepStatus =
				executed.status === "failed" ? "failed" : executed.status;
			return { status, code: executed.code };
		}
		const { outcome } = executed;
		switch (outcome.kind) {
			case "observation":
				latest = outcome.observation;
				noteUrl(outcome.observation.url);
				return {
					status: "confirmed",
					observationRef: outcome.observation.observationRef,
				};
			case "operation": {
				const { result, observation } = outcome;
				noteUrl(result.url);
				if (observation) noteUrl(observation.url);
				if (result.status === "confirmed") {
					// The page may have changed: what was read before is no longer what is there.
					latest = observation ?? null;
					return {
						status: "confirmed",
						operationId: result.operationId,
						...(observation
							? { observationRef: observation.observationRef }
							: {}),
						...(observation?.url !== undefined || result.url !== undefined
							? { url: observation?.url ?? (result.url as string) }
							: {}),
					};
				}
				return { status: "failed", code: result.code ?? "operation_failed" };
			}
			case "refused":
				return { status: "failed", code: outcome.code };
			case "stop":
				return { status: "needs_input", code: "approval_required" };
			case "tabs":
				return { status: "confirmed" };
			case "part":
				// A definition's steps are operations; a part result never comes back to it.
				return { status: "failed", code: "unexpected_part" };
		}
	}

	let tabRef = "";
	const operate = async (
		command: AdapterCommand,
		declaredEffect: DeclaredEffect,
		extra: {
			observationRef?: string;
			grantRef?: string;
			grantPurpose?: string;
		} = {},
	) =>
		settle(
			await executor.execute(
				{
					kind: "operate",
					tabRef,
					...(extra.observationRef
						? { observationRef: extra.observationRef }
						: {}),
					command,
					declaredEffect,
					...(extra.grantRef
						? {
								inputProvenance: {
									kind: "grant" as const,
									inputValueRef: extra.grantRef,
								},
							}
						: {}),
				},
				extra.grantPurpose !== undefined
					? { grantPurpose: extra.grantPurpose }
					: {},
			),
		);

	type Target =
		| {
				kind: "ok";
				ref: string;
				element: string;
				observationRef: string;
				objectId: number;
				candidateIds: number[];
		  }
		| { kind: "skip" }
		| { kind: "stop"; code: string };

	/** The element a step's `targetObject` is on the page in front of the browser. */
	function target(step: {
		targetObject: string;
		optional?: boolean | undefined;
	}): Target {
		const page = latest;
		if (!page) return { kind: "stop", code: "no_observation" };
		const found = lookupObject(db, owner, page.url ?? "", step.targetObject);
		// An optional step is skipped only when the object is not defined for this kind of page; a defined
		// object that is missing or ambiguous here stops the run.
		if (found.kind === "undefined")
			return step.optional
				? { kind: "skip" }
				: { kind: "stop", code: "object_undefined" };
		const hit = resolveObject(page.body, found.object.candidates);
		if (hit.kind === "found")
			return {
				kind: "ok",
				ref: hit.match.ref,
				element: (hit.match.name || hit.match.role).slice(0, 200),
				observationRef: page.observationRef,
				objectId: found.object.id,
				candidateIds: hit.candidateIds,
			};
		return {
			kind: "stop",
			code:
				hit.kind === "none"
					? "target_not_found"
					: hit.kind === "ambiguous"
						? "target_ambiguous"
						: "candidate_unsupported",
		};
	}

	/** Evidence that a stored candidate found the element an operation acted on. Nothing is verified by it. */
	function evidence(
		t: Extract<Target, { kind: "ok" }>,
		operationId: string | undefined,
	) {
		if (operationId === undefined) return;
		write(db, () => {
			for (const candidateId of t.candidateIds)
				recordEvidence(db, owner, t.objectId, {
					candidateId,
					outcome: "match",
					checkedAt: nowIso(),
					runId,
					operationId,
					observationRef: t.observationRef,
				});
		});
	}

	async function runStep(step: ResolvedStep): Promise<StepDone> {
		switch (step.action) {
			case "browser.navigate":
				return operate(
					{ action: "browser.navigate", url: step.args.url },
					"navigation",
				);
			case "page.wait":
				return operate(
					{ action: "page.wait", seconds: step.args.seconds },
					"none",
				);
			case "page.press":
				return operate(
					{ action: "page.press", key: step.args.key },
					"navigation",
				);
			case "page.observe": {
				const done = settle(
					await executor.execute({ kind: "observe", tabRef }),
				);
				const page = latest as ObservationEnvelope | null;
				return done.status === "confirmed" && page
					? {
							...done,
							bodyBytes: new TextEncoder().encode(page.body).length,
							refCount: page.refCount,
						}
					: done;
			}
			case "page.click":
			case "page.fill": {
				const t = target(step);
				if (t.kind === "skip") return { status: "skipped" };
				if (t.kind === "stop") return { status: "failed", code: t.code };
				let done: StepDone;
				const before = latest?.url;
				if (step.action === "page.click")
					done = await operate(
						{ action: "page.click", targetRef: t.ref, element: t.element },
						"navigation",
						{ observationRef: t.observationRef },
					);
				else {
					// The value is the caller's input, not text from a page or a model: the host holds it as an
					// approved value and types it by reference, so it reaches no record.
					let grantRef: string;
					try {
						grantRef = grants.approve({
							value: step.args.value,
							origin: latest?.url ?? "",
							purpose: step.id,
						}).inputValueRef;
					} catch (error) {
						if (error instanceof Refusal)
							return { status: "failed", code: error.code };
						throw error;
					}
					done = await operate(
						{
							action: "page.fill",
							targetRef: t.ref,
							element: t.element,
							text: "",
							submit: step.args.submit,
						},
						step.args.submit ? "navigation" : "input",
						{
							observationRef: t.observationRef,
							grantRef,
							grantPurpose: step.id,
						},
					);
				}
				if (done.status === "confirmed") evidence(t, done.operationId);
				// A submitted fill and a click are expected to navigate; say whether they did.
				const navigates = step.action === "page.click" || step.args.submit;
				return navigates &&
					done.status === "confirmed" &&
					before !== undefined &&
					done.url !== undefined
					? { ...done, urlChanged: done.url !== before }
					: done;
			}
			case "page.extract": {
				let root: string | null = null;
				let rootObservation: string | undefined;
				if (step.targetObject !== undefined) {
					const t = target({
						targetObject: step.targetObject,
						optional: step.optional,
					});
					if (t.kind === "skip") return { status: "skipped" };
					if (t.kind === "stop") return { status: "failed", code: t.code };
					root = t.ref;
					rootObservation = t.observationRef;
				}
				try {
					const content = await executor.extract(
						tabRef,
						rootObservation,
						root,
						step.args.maxChars,
					);
					extracts[step.id] = {
						url: content.url ?? latest?.url ?? null,
						title: content.title ?? null,
						text: content.text,
						charCount: content.charCount,
						truncated: content.truncated,
						root: content.root,
					};
					noteUrl(content.url);
					sink?.(runId, ++kept, {
						...(content.url === undefined ? {} : { url: content.url }),
						title: `[extract ${step.id}] ${content.title ?? ""}`,
						body: content.text,
					});
					return { status: "confirmed", charCount: content.charCount };
				} catch (error) {
					if (error instanceof Refusal)
						return { status: "failed", code: error.code };
					throw error;
				}
			}
		}
	}

	const cancelEnding = (): Ending => {
		const end = control.ended();
		return { status: end.status as RunStatus, code: end.code };
	};

	async function drive(): Promise<Ending> {
		await adapter.open(control.signal);
		tool = adapter.toolInfo();
		tabRef = await executor.attach();
		for (const [i, step] of steps.entries()) {
			if (control.signal.aborted) return cancelEnding();
			const began = now();
			const done = await runStep(step);
			if (control.signal.aborted && done.status !== "confirmed")
				return cancelEnding();
			reports[i] = {
				id: step.id,
				action: step.action,
				status: done.status,
				durationMs: Math.max(0, now() - began),
				...(done.bodyBytes === undefined ? {} : { bodyBytes: done.bodyBytes }),
				...(done.refCount === undefined ? {} : { refCount: done.refCount }),
				...(done.charCount === undefined ? {} : { charCount: done.charCount }),
				...(done.code === undefined ? {} : { code: done.code }),
				...(done.status === "skipped" ? { skipped: true as const } : {}),
				...(done.urlChanged === undefined
					? {}
					: { urlChanged: done.urlChanged }),
			};
			log("definition.step", { code: done.code ?? done.status });
			if (done.status === "confirmed" || done.status === "skipped") continue;
			if (done.status === "cancelled" || done.status === "expired")
				return cancelEnding();
			const status: RunStatus =
				done.status === "needs_input"
					? "needs_input"
					: done.status === "indeterminate"
						? "indeterminate"
						: "failed";
			return { status, code: done.code ?? null };
		}
		return { status: "completed", code: null };
	}

	let ending: Ending;
	let unexpected: unknown;
	try {
		ending = await drive();
	} catch (error) {
		if (
			control.signal.aborted &&
			(error instanceof RunEnd || error instanceof AdapterError)
		)
			ending = cancelEnding();
		else if (error instanceof RunEnd)
			ending = { status: error.status as RunStatus, code: error.code };
		else if (error instanceof AdapterError)
			ending = { status: "failed", code: error.code };
		else {
			unexpected = error;
			ending = { status: "failed", code: "host_error" };
		}
	} finally {
		clearTimeout(timer);
		try {
			// Only what this host started is stopped; the adapter's close is idempotent.
			await adapter.close();
		} catch {
			// A failing close must not hide how the run ended.
		} finally {
			control.signal.removeEventListener("abort", onAbort);
		}
	}
	if (control.signal.aborted) ending = cancelEnding();

	// Cancel and expiry already moved the run; any other end moves it now.
	try {
		write(db, () => {
			const current = getRun(db, owner, runId);
			if (current && isTerminalRunStatus(current.status))
				ending = { status: current.status, code: current.statusReason };
			if (current && !isTerminalRunStatus(current.status))
				transitionRun(db, owner, runId, ending.status, {
					nowIso: nowIso(),
					...(ending.code ? { reason: ending.code } : {}),
				});
			finishDefinitionRun(db, runId, {
				status: ending.status,
				// The URL may carry the search keyword: the stored summary keeps origin and path only.
				summary: {
					finalUrl: finalUrl === null ? null : originAndPath(finalUrl),
					steps: reports,
				},
				tool,
				nowIso: nowIso(),
			});
		});
	} catch {
		throw new RunPersistenceError();
	}
	log("definition.finished", { code: ending.status, count: reports.length });
	if (unexpected !== undefined) throw unexpected;
	const prompt = approver instanceof StopApprover ? approver.prompt : null;
	return {
		ok: ending.status === "completed",
		status: ending.status,
		code: ending.code,
		definition: meta,
		platform: adapter.platform,
		tool,
		inputs,
		finalUrl,
		steps: reports,
		extracts,
		runId,
		...(prompt && ending.status === "needs_input"
			? {
					approval: {
						action: prompt.action,
						page: prompt.page,
						element: prompt.element,
						summary: prompt.summary,
					},
				}
			: {}),
	};
}
