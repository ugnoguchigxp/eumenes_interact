import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Database } from "bun:sqlite";
import {
	decideSession,
	browserChoicePrompt,
	parseBrowserChoice,
	stepResultFact,
} from "eumenes-collaboration";
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
import { runTrial } from "../host/run.ts";
import {
	confirmPlayback,
	isPlaybackGoal,
	probeKeptMedia,
	type MediaSample,
} from "../host/playback.ts";
import { createExperiment } from "../host/store.ts";
import { collectVersions } from "../host/versions.ts";
import { createManualInference } from "../inference/manual.ts";
import { RunControl } from "../host/control.ts";
import { parseCaptureDir } from "./arm.ts";
import { createSession } from "./session.ts";

export type ChainOptions = {
	request: string;
	/** Only `manual` for now: the summary step needs a plain-text call the other ports do not expose here. */
	inference: "manual";
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
	const dir = process.env.LAB_MANUAL_DIR;
	if (!dir) throw new Error("manual_needs_LAB_MANUAL_DIR");
	const captureDir = parseCaptureDir(o.captureDir);
	const plan = chainPlan(o.request);
	/** Steps whose own inference chose the browser. */
	const routed = new Set<string>();
	const budget = planBudget(plan.steps.length);
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
		budget: { maxModelCalls: budget.overall, inference: { kind: "scripted" } },
		inferenceKind: "scripted",
		nowIso: new Date().toISOString(),
	});
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
	const session = await createSession(
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
	let used = 0;
	let keep = false;
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
			const check = budgetCheck(used, budget);
			if (check.decision === "stop") {
				stopped = "budget_exhausted";
				break;
			}
			if (check.decision === "ask") {
				console.log(
					`partial\t残り推論 ${check.remaining} 回。ここまでの結果:\n${[...results].map(([k, v]) => `[${k}] ${v}`).join("\n")}`,
				);
				console.log("ask\t続けますか？ (はい/いいえ)");
				const answer = (await nextLine()) ?? "";
				if (!/^(はい|yes|y|続け)/iu.test(answer.trim())) {
					stopped = "user_stopped_at_budget";
					break;
				}
			}
			let maxCalls = Math.min(budget.perStep, check.remaining);
			let def = chainCases(plan, o.request, results, maxCalls, routed)[index]!
				.def;
			let decided: string | null = null;
			let answered: { text: string; code: string | null } | null = null;
			if (!def) {
				const decision = step.browser;
				const deciding = decision.by === "agent";
				// Its own file name: a browser trial for the same step (chain-<id>) must not read this answer.
				const port = createManualInference(dir, `decide-${step.id}`);
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
								? `${summaryPrompt(step, o.request, results)}\n\n${browserChoicePrompt(decision.signals)}`
								: summaryPrompt(step, o.request, results),
						},
					],
					maxOutputTokens: 2048,
					signal: AbortSignal.any([
						runControl.signal,
						AbortSignal.timeout(30 * 60_000),
					]),
				});
				used += 1;
				const raw = out.kind === "text" ? out.text : "";
				const choice = deciding
					? parseBrowserChoice(raw)
					: { browser: false, rationale: "plan", answer: raw };
				// The decision and its reason are logged, so a misjudgment can be found and fed back as history.
				console.error(
					`browser\t${step.id}\t${choice.browser ? "yes" : "no"}\t${choice.rationale}`,
				);
				if (choice.browser) {
					routed.add(step.id);
					maxCalls = Math.min(budget.perStep, check.remaining) - 1;
					def = chainCases(plan, o.request, results, maxCalls, routed)[index]!
						.def;
					decided = choice.rationale;
				} else {
					answered = { text: choice.answer, code: out.kind };
				}
			}
			if (!def || answered) {
				const text = answered?.text ?? "";
				results.set(step.id, text);
				outcomes.push({
					id: step.id,
					goal: step.goal,
					browser: false,
					keepOpen: false,
					status: text ? "completed" : "failed",
					code: text ? null : (answered?.code ?? "no_route"),
					modelCalls: 1,
					result: text,
				});
				continue;
			}
			const result = await runTrial({
				db,
				def,
				arm: "arm1",
				experimentId,
				repetition: 1,
				orderIndex: index,
				adapter: hold.adapter,
				inference: asCollabAgent(createManualInference(dir, def.id)),
				inferenceInfo: () => ({ kind: "scripted" }),
				approver: new StopApprover(),
				control: runControl,
				logger,
				versions: collectVersions({
					browser: {
						channel: o.browser ?? null,
						customExecutable: false,
						headless: !o.headed,
					},
				}),
				sources: [...results.values()],
				goal: step.goal,
				keepSession: true,
				...(step.keepOpen && isPlaybackGoal(step.goal)
					? {
							beforeFinish: async () => {
								const verdict = await confirmPlayback({
									sample: async () =>
										(await session.adapter.inspect(
											"inspectMedia",
											null,
											AbortSignal.timeout(5000),
										)) as unknown as MediaSample,
									sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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
					? { observationSink: createObservationSink(DEFAULT_OBSERVATIONS_DIR) }
					: {}),
			});
			used += result.score.efficiency.modelCalls;
			results.set(step.id, result.finalText);
			if (result.status === "completed")
				facts.push(stepResultFact(step.id, result.finalText, [result.runId]));
			outcomes.push({
				id: step.id,
				goal: step.goal,
				browser: true,
				keepOpen: step.keepOpen,
				status: result.status,
				code: result.code,
				// The step's own inference that chose the browser counts too.
				modelCalls:
					result.score.efficiency.modelCalls + (decided === null ? 0 : 1),
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
				{ request: o.request, used, budget, stopped, outcomes, facts },
				null,
				1,
			),
		);
		if (keep) {
			console.log(
				`kept\tブラウザを開いたままにしています。閉じるときは「完了」と入力してください（再生が止まって無操作 ${o.keepOpenIdleS} 秒、または最長 ${o.keepOpenMaxS} 秒で自動的に閉じます）。`,
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
				(line) => decideSession(line, false).decision === "close",
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

/** How long closing the browser may take before the run ends without it. */
const CLOSE_WAIT_MS = 15_000;

/** Short enough that a typical 15–30 s mid-roll ad is seen while it shows. */
const MEDIA_PROBE_MS = 10_000;

export { DEFAULT_KEEP_OPEN_IDLE_S, DEFAULT_KEEP_OPEN_MAX_S };
