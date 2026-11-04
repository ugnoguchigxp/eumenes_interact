import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Database } from "bun:sqlite";
import { decideSession, stepResultFact } from "eumenes-collaboration";
import { asCollabAgent } from "../host/collab.ts";
import {
	DEFAULT_KEEP_OPEN_IDLE_S,
	budgetCheck,
	chainCases,
	holdSession,
	holdUntil,
	planBudget,
	planSteps,
	summaryPrompt,
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
	keptMediaNotice,
	type MediaSample,
} from "../host/playback.ts";
import { createExperiment } from "../host/store.ts";
import { collectVersions } from "../host/versions.ts";
import { createManualInference } from "../inference/manual.ts";
import { parseCaptureDir } from "./arm.ts";
import { createSession } from "./session.ts";

export type ChainOptions = {
	request: string;
	/** Only `manual` for now: the summary step needs a plain-text call the other ports do not expose here. */
	inference: "manual";
	keepOpenIdleS: number;
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
	const plan = planSteps(o.request, "request");
	const budget = planBudget(plan.steps.length);
	console.error(
		`plan\t${plan.steps.map((s) => `${s.id}${s.needsBrowser ? (s.keepOpen ? "[browser,keep-open]" : "[browser]") : "[no browser]"} ${s.goal}`).join(" | ")}`,
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
	const session = await createSession(
		{ headed: o.headed, ...(o.browser ? { browser: o.browser } : {}) },
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
			const maxCalls = Math.min(budget.perStep, check.remaining);
			const def = chainCases(plan, o.request, results, maxCalls)[index]!.def;
			if (!def) {
				const port = createManualInference(dir, `chain-${step.id}`);
				const out = await port.complete({
					messages: [
						{
							role: "system",
							content:
								"あなたは依頼者のために結果をまとめます。与えられた確認済みの結果だけを使い、日本語で簡潔に答えてください。",
						},
						{ role: "user", content: summaryPrompt(step, o.request, results) },
					],
					maxOutputTokens: 2048,
					signal: AbortSignal.timeout(30 * 60_000),
				});
				used += 1;
				const text = out.kind === "text" ? out.text : "";
				results.set(step.id, text);
				outcomes.push({
					id: step.id,
					goal: step.goal,
					browser: false,
					keepOpen: false,
					status: text ? "completed" : "failed",
					code: text ? null : out.kind,
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
								return verdict.ok ? { ok: true } : { ok: false, code: verdict.code };
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
				modelCalls: result.score.efficiency.modelCalls,
				result: result.finalText,
				runId: result.runId,
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
				`kept\tブラウザを開いたままにしています。閉じるときは「完了」と入力してください（無操作 ${o.keepOpenIdleS} 秒で自動的に閉じます）。`,
			);
			// While kept, the largest video's playback position is read (read-only) every 10 s and an ad start/end or the end is told, so "it keeps
			// playing" is a measured fact rather than a guess from screenshots.
			let prev: MediaSample | null = null;
			const probe = async () => {
				try {
					const m = (await session.adapter.inspect(
						"inspectMedia",
						null,
						AbortSignal.timeout(5000),
					)) as MediaSample;
					console.log(
						`media\t${new Date().toISOString()}\t${JSON.stringify(m)}`,
					);
					// A mid-roll ad (or the end) is told as it is seen; the ad itself is never skipped here.
					const notice = keptMediaNotice(prev, m);
					if (notice) console.log(`notice\t${notice}`);
					prev = m;
				} catch (error) {
					console.log(
						`media\t${new Date().toISOString()}\tunread:${String(error)}`,
					);
				}
			};
			await probe();
			const timer = setInterval(() => void probe(), MEDIA_PROBE_MS);
			const why = await holdUntil(
				input,
				(line) => decideSession(line, false).decision === "close",
				o.keepOpenIdleS * 1000,
			);
			clearInterval(timer);
			await probe();
			console.log(`closed\t${why}`);
		}
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await hold.release().catch(() => {});
		await session.dispose().catch(() => {});
		// Closing the reader is what lets the process exit while stdin (a fifo or a terminal) stays open.
		rl.close();
		process.stdin.destroy();
	}
	return stopped === null && outcomes.every((s) => s.status === "completed")
		? 0
		: 1;
}

/** Short enough that a typical 15–30 s mid-roll ad is seen while it shows. */
const MEDIA_PROBE_MS = 10_000;

export { DEFAULT_KEEP_OPEN_IDLE_S };
