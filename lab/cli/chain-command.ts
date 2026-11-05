import {
	AllowlistApprover,
	DEFAULT_ALLOWLIST_PATH,
	loadAllowlist,
} from "../host/allowlist.ts";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { stepResultFact } from "eumenes-collaboration";
import { CallBudget } from "../inference/call-budget.ts";
import {
	startClaude,
	startLuna,
	ensureClaudeCredential,
	type ClaudeSession,
} from "../host/claude.ts";
import type { InferencePort } from "eumenes-interact";
import { asCollabAgent } from "../host/collab.ts";
import {
	DEFAULT_KEEP_OPEN_IDLE_S,
	DEFAULT_KEEP_OPEN_MAX_S,
	budgetCheck,
	chainPlan,
	chainCases,
	holdSession,
	holdUntil,
	settleWithin,
	playbackAdvanced,
	planBudget,
	summaryPrompt,
	toBrowser,
} from "../host/chain.ts";
import type { LabLogger } from "../host/log.ts";
import {
	DEFAULT_OBSERVATIONS_DIR,
	createObservationSink,
} from "../host/observations.ts";
import { StopApprover } from "../host/approval.ts";
import { askChoice, chosenLine, parseChoices } from "../host/choice.ts";
import { runTrial } from "../host/run.ts";
import {
	confirmPlayback,
	probeKeptMedia,
	type MediaSample,
} from "../host/playback.ts";
import { createExperiment } from "../host/store.ts";
import {
	DEFAULT_BROWSER_HISTORY,
	loadBrowserHistory,
} from "../host/browser-history.ts";
import { collectVersions } from "../host/versions.ts";
import { createManualInference } from "../inference/manual.ts";
import { RunControl } from "../host/control.ts";
import { parseCaptureDir } from "./arm.ts";
import { createSession } from "./session.ts";

export type ChainOptions = {
	request: string;
	/** Planning, operations and summary share this inference provider. */
	inference: "manual" | "claude" | "openai";
	keepOpenIdleS: number;
	keepOpenMaxS: number;
	headed: boolean;
	browser?: string;
	captureDir?: string;
	keepObservations: boolean;
};

export type ChainStepOutcome = {
	id: string;
	goal: string;
	browser: boolean;
	keepOpen: boolean;
	status: string;
	code: string | null;
	modelCalls: number;
	result: string;
	runId?: string;
};

/**
 * `chain`: plans the request, runs its steps on one headed browser, prints each step's result and, when a
 * step's result is the screen, keeps the browser open until the user types 完了/done (or the idle timeout).
 */
export async function chainCommand(
	db: Database,
	o: ChainOptions,
	logger: LabLogger,
): Promise<number> {
	let apiSession: ClaudeSession | null = null;
	if (o.inference === "claude") {
		ensureClaudeCredential();
		apiSession = startClaude(
			{ model: "claude-haiku-5-5", effort: "low" },
			logger,
			"chain",
		);
	}
	if (o.inference === "openai") apiSession = startLuna();
	try {
		return await executeChain(db, o, logger, apiSession);
	} finally {
		await apiSession?.dispose();
	}
}
export async function executeChain(
	db: Database,
	o: ChainOptions,
	logger: LabLogger,
	apiSession: ClaudeSession | null,
	createBrowser: typeof createSession = createSession,
): Promise<number> {
	const dir = process.env.LAB_MANUAL_DIR;
	if (o.inference === "manual" && !dir)
		throw new Error("manual_needs_LAB_MANUAL_DIR");
	const calls = new CallBudget(30);
	const rawPort = (id: string): InferencePort =>
		apiSession?.raw ?? createManualInference(dir!, id);
	const stepScope = (id: string) => `step:${id}`;
	const completionVerifiers = apiSession?.port.completionVerifiers ?? [];
	const portFor = (id: string, scope = id) =>
		calls.port(rawPort(id), stepScope(scope), 10);
	const captureDir = parseCaptureDir(o.captureDir);
	const historyPath =
		process.env.LAB_BROWSER_HISTORY ?? DEFAULT_BROWSER_HISTORY;
	const plan = await chainPlan(
		o.request,
		calls.port(rawPort("plan"), "planning", 1),
		AbortSignal.timeout(120_000),
		loadBrowserHistory(historyPath),
	);
	/** Steps whose own inference chose the browser. */
	const routed = new Set<string>();
	const budget = planBudget(plan.steps.length);
	calls.constrain(budget.overall);
	console.error(
		`plan\t${plan.steps.map((s) => `${s.id}${toBrowser(s) ? (s.keepOpen ? "[browser,keep-open]" : "[browser]") : s.browser.by === "agent" ? "[step decides]" : "[no browser]"} ${s.goal}`).join(" | ")}`,
	);
	console.error(
		`budget\tper step ${budget.perStep}\toverall ${budget.overall}`,
	);
	const experimentId = `chain-${randomUUID()}`;
	createExperiment(db, {
		id: experimentId,
		name: "chain",
		caseIds: plan.steps.map((s) => `chain-${s.id}`),
		caseDigest: createHash("sha256").update(o.request).digest("hex"),
		includesHoldout: false,
		includesLive: true,
		repetitions: 1,
		arms: ["arm1"],
		budget: {
			maxModelCalls: budget.overall,
			inference: apiSession?.info() ?? { kind: "scripted" },
		},
		inferenceKind: o.inference === "manual" ? "scripted" : o.inference,
		nowIso: new Date().toISOString(),
	});
	// Host-approved clicks (lab/config/action-allowlist.json, or LAB_ACTION_ALLOWLIST); the rest stays gated.
	const allowlist = loadAllowlist(
		process.env.LAB_ACTION_ALLOWLIST || DEFAULT_ALLOWLIST_PATH,
	);
	const rl = createInterface({ input: process.stdin });
	const lines = rl[Symbol.asyncIterator]();
	const input = { [Symbol.asyncIterator]: () => lines };
	const nextLine = async () => {
		const n = await lines.next();
		return n.done ? null : n.value;
	};
	// Mid-step tear-down of the fifo (or Ctrl-D): cancel the in-flight trial so the lock is not held until
	// the 30-minute call timeout (review 2026-11-05 M1). keep-open already ends on EOF via holdUntil.
	const runControl = new RunControl();
	const onInputGone = () => runControl.cancel("cancel");
	process.stdin.once("end", onInputGone);
	process.stdin.once("close", onInputGone);
	const session = await createBrowser(
		{
			headed: o.headed,
			...(o.browser ? { browser: o.browser } : {}),
			netGuard: {
				onBlock: (b) => console.log(`guard\t${b.code}\t${b.host}`),
			},
		},
		logger,
	);
	const hold = holdSession(session.adapter);
	const results = new Map<string, string>();
	const facts = [...plan.facts];
	const outcomes: ChainStepOutcome[] = [];
	let keep = false;
	/** Where the browser was left by the last browser step; an agent-routed step continues there (L9). */
	let lastPage: string | null = null;
	let stopped: string | null = null;
	// Ctrl-C or a kill while a browser is kept open: the browser is closed, not left behind.
	const onSignal = (signal: NodeJS.Signals) => {
		console.log(`closed\tsignal:${signal}`);
		void Promise.allSettled([hold.release(), session.dispose()]).then(() =>
			process.exit(130),
		);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		for (const [index, step] of plan.steps.entries()) {
			const check = budgetCheck(calls.used, budget);
			if (check.decision === "stop") {
				stopped = "budget_exhausted";
				break;
			}
			if (check.decision === "ask" && index > 0) {
				console.log(
					`partial\t残り推論 ${check.remaining} 回。ここまでの結果:\n${[...results].map(([k, v]) => `[${k}] ${v}`).join("\n")}`,
				);
				console.log(
					"ask\t続行する場合は1、終了する場合は2を入力してください。",
				);
				const answer = (await nextLine()) ?? "";
				if (answer.trim() !== "1") {
					stopped = "user_stopped_at_budget";
					break;
				}
			}
			let maxCalls = calls.remaining(stepScope(step.id), budget.perStep);
			let def = chainCases(
				plan,
				o.request,
				results,
				maxCalls,
				routed,
				lastPage,
			)[index]!.def;
			let decided: string | null = null;
			let answered: { text: string; code: string | null } | null = null;
			if (!def) {
				const decision = step.browser;
				const deciding = decision.by === "agent";
				// Its own file name: a browser trial for the same step (chain-<id>) must not read this answer.
				const port = portFor(`decide-${step.id}`, step.id);
				const out = await port.complete({
					messages: [
						{
							role: "system",
							content: deciding
								? "あなたは依頼者のためにこのステップを進めます。与えられた確認済みの結果で答えられるならそれだけを使い、日本語で簡潔に答えます。新しく調べる必要があればブラウザを使います。"
								: "あなたは依頼者のために結果をまとめます。与えられた確認済みの結果だけを使い、日本語で簡潔に答えてください。",
						},
						{
							role: "user",
							content: deciding
								? `${summaryPrompt(step, o.request, results)}\n外部確認が必要ならbrowser=true。不要ならbrowser=falseで答え、達成できた範囲をoutcomeで明示してください。`
								: summaryPrompt(step, o.request, results),
						},
					],
					maxOutputTokens: 2048,
					outputSchema: {
						type: "object",
						properties: {
							browser: { type: "boolean" },
							answer: { type: "string" },
							rationale: { type: "string" },
							outcome: {
								type: "string",
								enum: ["achieved", "partial", "unmet"],
							},
						},
						required: ["browser", "answer", "rationale", "outcome"],
						additionalProperties: false,
					},
					signal: AbortSignal.any([
						runControl.signal,
						AbortSignal.timeout(30 * 60_000),
					]),
				});
				const raw = out.kind === "text" ? out.text : "";
				let choice: {
					browser: boolean;
					answer: string;
					rationale: string;
					outcome: string;
				};
				try {
					choice = JSON.parse(raw);
				} catch {
					throw new Error("step_decision_invalid");
				}
				if (
					typeof choice.browser !== "boolean" ||
					typeof choice.answer !== "string" ||
					typeof choice.rationale !== "string" ||
					!["achieved", "partial", "unmet"].includes(choice.outcome)
				)
					throw new Error("step_decision_invalid");

				// The decision and its reason are logged, so a misjudgment can be found and fed back as history.
				console.error(
					`browser\t${step.id}\t${choice.browser ? "yes" : "no"}\t${choice.rationale}`,
				);
				if (choice.browser) {
					routed.add(step.id);
					maxCalls = Math.min(budget.perStep, check.remaining) - 1;
					def = chainCases(
						plan,
						o.request,
						results,
						maxCalls,
						routed,
						lastPage,
					)[index]!.def;
					decided = choice.rationale;
				} else {
					answered = {
						text: choice.answer,
						code:
							choice.outcome === "achieved" ? null : `goal_${choice.outcome}`,
					};
				}
			}
			if (!def || answered) {
				const text = answered?.text ?? "";
				if (text && !answered?.code) results.set(step.id, text);
				outcomes.push({
					id: step.id,
					goal: step.goal,
					browser: false,
					keepOpen: false,
					status: text && !answered?.code ? "completed" : "failed",
					code: answered?.code ?? (text ? null : "no_route"),
					modelCalls: 1,
					result: text,
				});
				if (!text || answered?.code) {
					stopped = `step_failed:${step.id}`;
					break;
				}
				continue;
			}
			let result: Awaited<ReturnType<typeof runTrial>>;
			if (calls.remaining(stepScope(step.id), budget.perStep) === 0) {
				stopped = "budget_exhausted";
				break;
			}
			// The text choice channel (lab/host/choice.ts): an `ask` with numbered options is put to the user,
			// and the step runs again from the same page with the pick; no option is ever chosen for them.
			let asked = 0;
			let choiceStop: string | null = null;
			const picked: string[] = [];
			for (;;) {
				result = await runTrial({
					db,
					def: {
						...def,
						budget: {
							maxModelCalls: calls.remaining(
								stepScope(step.id),
								budget.perStep,
							),
						},
					},
					authorityRequest: [o.request, ...picked].join("\n"),
					arm: "arm1",
					experimentId,
					// A rerun after a choice is its own trial row (experiment, case, arm, repetition is unique).
					repetition: 1 + asked,
					orderIndex: index,
					adapter: hold.adapter,
					inference: asCollabAgent(
						portFor(asked ? `${def.id}-c${asked}` : def.id, step.id),
						{
							completionVerifiers: completionVerifiers.map((port) =>
								calls.port(port, stepScope(step.id), 10),
							),
						},
					),
					inferenceInfo: apiSession?.info ?? (() => ({ kind: "scripted" })),
					approver: new AllowlistApprover(
						allowlist,
						new StopApprover(),
						(line) => console.error(line),
					),
					control: runControl,
					logger,
					versions: collectVersions({
						browser: {
							channel: o.browser ?? null,
							customExecutable: false,
							headless: !o.headed,
						},
					}),
					sources: [...results.values(), ...picked],
					goal: step.goal,
					keepSession: true,
					...(step.completion === "playback"
						? {
								beforeFinish: async (signal) => {
									const verdict = await confirmPlayback({
										signal,
										sample: async () =>
											(await session.adapter.inspect(
												"inspectMedia",
												null,
												AbortSignal.any([signal, AbortSignal.timeout(5000)]),
											)) as unknown as MediaSample,
										sleep: (ms) => Bun.sleep(ms),
										notify: (m) => console.log(`notice\t${m}`),
									});
									console.log(
										`playback\t${verdict.ok ? "confirmed" : verdict.code}\t${JSON.stringify(verdict.samples.slice(-3))}`,
									);
									return verdict.ok
										? { ok: true }
										: { ok: false, code: verdict.code };
								},
							}
						: {}),
					...(captureDir ? { captureDir } : {}),
					...(o.keepObservations
						? {
								observationSink: createObservationSink(
									DEFAULT_OBSERVATIONS_DIR,
								),
							}
						: {}),
				});
				const choices =
					result.status === "needs_input" &&
					result.code === "clarify" &&
					asked < 2
						? parseChoices(result.finalText ?? "")
						: null;
				if (!choices) break;
				const pick = await askChoice({
					step: step.id,
					choices,
					nextLine,
					print: (line) => console.log(line),
					...(dir
						? {
								file: join(
									dir,
									`choice-${experimentId}-${step.id}-${asked}.json`,
								),
							}
						: {}),
				});
				if (pick.kind === "stopped") {
					console.log(`choice\tstopped\t${pick.code}`);
					choiceStop = pick.code;
					break;
				}
				asked += 1;
				if (
					calls.remaining(stepScope(step.id), budget.perStep) <
					completionVerifiers.length + 1
				) {
					choiceStop = "budget_exhausted";
					break;
				}
				picked.push(pick.option);
				const here = await currentPage(hold.adapter);
				def = {
					...def,
					request: `${def.request}\n${chosenLine(choices, pick.option)}`,
					...(here && /^https?:/u.test(here) ? { start: here } : {}),
				};
			}
			lastPage = await currentPage(hold.adapter);
			if (result.status === "completed") results.set(step.id, result.finalText);
			if (result.status === "completed")
				facts.push(stepResultFact(step.id, result.finalText, [result.runId]));
			outcomes.push({
				id: step.id,
				goal: step.goal,
				browser: true,
				keepOpen: step.keepOpen,
				status: result.status,
				code: choiceStop ?? result.code,
				// The step's own inference that chose the browser counts too.
				modelCalls: calls.scopeUsed(stepScope(step.id)),
				result: result.finalText,
				runId: result.runId,
				...(decided === null ? {} : { routedBy: decided }),
			});
			// The browser stays when this step's result is the screen; a later browser step reuses it.
			keep = step.keepOpen && result.status === "completed";
			if (result.status !== "completed") {
				stopped = `step_${result.status}:${step.id}`;
				break;
			}
		}
		console.log(
			JSON.stringify(
				{
					request: o.request,
					used: calls.used,
					budget,
					stopped,
					outcomes,
					facts,
				},
				null,
				1,
			),
		);
		if (keep) {
			console.log(
				`kept\tブラウザを開いたままにしています。閉じるときは0を入力してください（再生が止まって無操作 ${o.keepOpenIdleS} 秒、または最長 ${o.keepOpenMaxS} 秒で自動的に閉じます）。`,
			);
			// While kept, the largest video's playback position is read (read-only) every 10 s and an ad start/end or the end is told, so "it keeps
			// playing" is a measured fact rather than a guess from screenshots.
			let prev: MediaSample | null = null;
			let lastActive = 0;
			const probe = async () => {
				const before = prev;
				prev = await probeKeptMedia(
					() =>
						session.adapter.inspect(
							"inspectMedia",
							null,
							AbortSignal.timeout(5000),
						) as Promise<MediaSample>,
					prev,
					(line) => console.log(line),
				);
				// A video that is playing keeps the session from going idle.
				if (playbackAdvanced(before, prev)) lastActive = Date.now();
			};
			await probe();
			const timer = setInterval(() => void probe(), MEDIA_PROBE_MS);
			const why = await holdUntil(
				input,
				(line) => line.trim() === "0",
				o.keepOpenIdleS * 1000,
				{ lastActive: () => lastActive, maxMs: o.keepOpenMaxS * 1000 },
			);
			clearInterval(timer);
			await probe();
			console.log(`closed\t${why}`);
		}
	} finally {
		process.stdin.off("end", onInputGone);
		process.stdin.off("close", onInputGone);
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		// Bounded: a close that never answers must not hold the run lock (S11 hung here after closed, 2026-11-05).
		const closedInTime = await settleWithin(
			(async () => {
				await hold.release().catch(() => {});
				await session.dispose().catch(() => {});
			})(),
			CLOSE_WAIT_MS,
		);
		if (!closedInTime) console.error("notice\tbrowser_close_timeout");
		// Closing the reader is what lets the process exit while stdin (a fifo or a terminal) stays open.
		rl.close();
		process.stdin.destroy();
	}
	return stopped === null && outcomes.every((s) => s.status === "completed")
		? 0
		: 1;
}

/** The address of the tab in front, read without touching the page; null when it cannot be read. */
async function currentPage(adapter: {
	listTargets(
		signal: AbortSignal,
	): Promise<{ current: boolean; url?: string }[]>;
}): Promise<string | null> {
	try {
		const tabs = await adapter.listTargets(AbortSignal.timeout(5000));
		return tabs.find((t) => t.current)?.url ?? null;
	} catch {
		return null;
	}
}

/** How long closing the browser may take before the run ends without it. */
const CLOSE_WAIT_MS = 15_000;

/** Short enough that a typical 15–30 s mid-roll ad is seen while it shows. */
const MEDIA_PROBE_MS = 10_000;

export { DEFAULT_KEEP_OPEN_IDLE_S, DEFAULT_KEEP_OPEN_MAX_S };
