import { createManualInference } from "../inference/manual.ts";
import type { Database } from "bun:sqlite";
import type { ArmId } from "eumenes-interact";
import { loadCases } from "../cases/load.ts";
import type { CaseDef } from "../cases/schema.ts";
import { CliApprover, FixtureApprover } from "../host/approval.ts";
import { larmFactory } from "../host/larm.ts";
import { runExperiment, type TrialFactories } from "../host/experiment.ts";
import { startFixtureServer } from "../host/fixture-server.ts";
import type { LabLogger } from "../host/log.ts";
import {
	DEFAULT_OBSERVATIONS_DIR,
	createObservationSink,
	pruneObservations,
} from "../host/observations.ts";
import { selectCases } from "../host/plan.ts";
import type { TrialResult } from "../host/run.ts";
import { collectVersions } from "../host/versions.ts";
import { asCollabAgent, collabScriptedAgent } from "../host/collab.ts";
import {
	createArm1ScriptedInference,
	loadArm1Script,
} from "../scripted/arm1.ts";
import { DEFAULT_CAPTURES_DIR } from "../host/parts/capture.ts";
import type { BrowserPlatform } from "./platform.ts";
import {
	claudeSettings,
	ensureClaudeCredential,
	startClaude,
} from "../host/claude.ts";
import { checkArmInference, parseCaptureDir } from "./arm.ts";
import { createSession } from "./session.ts";
import { summaryLines } from "./report.ts";

export type RunOptions = {
	caseId?: string;
	split?: "dev" | "holdout" | "live";
	includeHoldout: boolean;
	includeLive: boolean;
	repeat: number;
	inference: "scripted" | "larm" | "claude" | "manual";
	/** `--inference claude`: the model (default `claude-haiku-5-5`) and effort (default `low`). */
	model?: string;
	effort?: string;
	/** `--inference claude`: the output bound of one call, recorded with the run's conditions. */
	maxTokens?: string;
	/** `arm1` (registered parts; the only arm since M4). */
	arm?: ArmId;
	/** Arm 1: an existing absolute directory the screenshots go to; default: `lab/data/captures/<runId>/`. */
	captureDir?: string;
	/** Default: the fixture user for fixtures, the terminal for live cases. */
	approver?: "fixture" | "cli";
	/** Keep every observation body under `lab/data/observations/` (at most 7 days). */
	keepObservations: boolean;
	headed: boolean;
	/** Default `playwright-mcp`. */
	platform?: BrowserPlatform;
	browser?: string;
	executablePath?: string;
};

/**
 * Real inference, holdout and live runs are the user's to start (plan.md §10.2, §10.5): say so on every one.
 * A live run answers approvals from the terminal unless `--approver fixture` is given, which says what answers.
 */
export function notices(
	options: RunOptions,
	holdout: boolean,
	live: boolean,
	approvalNotes: readonly string[] = [],
): string[] {
	return [
		...(options.inference === "larm"
			? [
					"notice: --inference larm calls the real LARM; start it only when you have decided to (user-triggered, plan §10.5).",
				]
			: []),
		...(options.inference === "claude"
			? [
					"notice: --inference claude calls the Claude API with the key in your .env and costs money; start it only when you have decided to (user-triggered, plan §10.5).",
				]
			: []),
		...(live
			? [
					"notice: live cases visit real sites; start them only when you have decided to (user-triggered, plan §10.2).",
				]
			: []),
		...(live && options.approver === "fixture"
			? [
					`notice: --approver fixture answers approvals from the case's approvalScript, unattended. ${approvalNotes.join(" ")}`.trim(),
				]
			: []),
		...(holdout
			? [
					"notice: holdout cases are for the take-back decision only; start them only when you have decided to (user-triggered, plan §10.2).",
				]
			: []),
	];
}

/** The inference factory: scripted files per dev case, or LARM with the token taken from the environment. */
function inferenceFactory(
	db: Database,
	options: RunOptions,
	logger: LabLogger,
): TrialFactories["inference"] {
	if (options.inference === "scripted")
		return async (def) => ({
			port: collabScriptedAgent(
				createArm1ScriptedInference(await loadArm1Script(def.id)),
			),
			info: () => ({ kind: "scripted" }),
			dispose: async () => {},
		});
	if (options.inference === "manual") {
		const dir = process.env.LAB_MANUAL_DIR;
		if (!dir) throw new Error("manual_needs_LAB_MANUAL_DIR");
		return async (def) => ({
			port: asCollabAgent(createManualInference(dir, def.id)),
			info: () => ({ kind: "scripted" }),
			dispose: async () => {},
		});
	}
	if (options.inference === "claude") {
		// Frozen for the whole run, and checked before anything is opened.
		const settings = claudeSettings(options);
		ensureClaudeCredential();
		return async (def) => startClaude(settings, logger, def.id);
	}
	const start = larmFactory(db, logger);
	return async (def) => start(def.id);
}

export async function runCommand(
	db: Database,
	options: RunOptions,
	logger: LabLogger,
) {
	if (
		options.inference !== "claude" &&
		(options.model || options.effort || options.maxTokens)
	)
		throw new Error("model_and_effort_are_for_claude");
	const arm = options.arm ?? "arm1";
	checkArmInference(arm, options.inference);
	// Refused before anything is opened.
	const captureDir = parseCaptureDir(options.captureDir);
	const all = await loadCases({
		includeHoldout: options.includeHoldout,
		includeLive: options.includeLive,
	});
	const cases = selectCases(all, options);
	const holdout = cases.some((c) => c.split === "holdout");
	const live = cases.every((c) => c.split === "live");
	if (!live && cases.some((c) => c.split === "live"))
		throw new Error("live_cases_run_alone");
	const approver = options.approver ?? (live ? "cli" : "fixture");
	// A missing script is found before anything starts.
	if (options.inference === "scripted")
		for (const def of cases) await loadArm1Script(def.id);
	const approvalNotes = cases.flatMap((c) =>
		c.approvalScript.note ? [c.approvalScript.note] : [],
	);
	for (const line of notices(
		{ ...options, approver },
		holdout,
		live,
		approvalNotes,
	))
		console.error(line);
	// Observation bodies of earlier runs that outlived their week go first (plan.md §14).
	await pruneObservations(DEFAULT_OBSERVATIONS_DIR, Date.now());
	await pruneObservations(DEFAULT_CAPTURES_DIR, Date.now());
	const inference = inferenceFactory(db, options, logger);
	// A live run needs no fixture server: it goes to the real site, within the case's allowed origins.
	const server = live ? null : startFixtureServer();
	const results: { def: CaseDef; result: TrialResult }[] = [];
	let current: { cancel(): void } | null = null;
	const onSigint = () => {
		if (current) current.cancel();
		else process.exit(130);
	};
	process.on("SIGINT", onSigint);
	try {
		const done = await runExperiment({
			db,
			cases,
			arms: [arm],
			...(captureDir ? { captureDir } : {}),
			repetitions: options.repeat,
			name: options.caseId ?? options.split ?? "run",
			inferenceKind:
				options.inference === "manual" ? "scripted" : options.inference,
			...(options.inference === "claude"
				? { frozenInference: claudeSettings(options) }
				: {}),
			includesHoldout: holdout,
			includesLive: live,
			logger,
			versions: collectVersions({
				browser: {
					channel: options.browser ?? null,
					customExecutable: options.executablePath !== undefined,
					headless: !options.headed,
				},
			}),
			...(server ? { fixtureBaseUrl: server.baseUrl } : {}),
			...(options.keepObservations
				? { observationSink: createObservationSink(DEFAULT_OBSERVATIONS_DIR) }
				: {}),
			onControl: (control) => {
				current = control;
			},
			onTrial: (result, def) => {
				results.push({ def, result });
				console.log(
					[
						def.id,
						result.status,
						result.score.success ? "success" : "failure",
						result.score.failures.join(",") || "-",
					].join("\t"),
				);
			},
			factories: {
				inference,
				approver: (def) =>
					approver === "cli"
						? new CliApprover()
						: new FixtureApprover(def.approvalScript),
				adapter: () => createSession(options, logger),
			},
		});
		console.log(`experiment\t${done.experimentId}`);
		for (const { result } of results)
			for (const line of summaryLines(result)) console.log(line);
		if (options.keepObservations)
			console.log(`observations\t${DEFAULT_OBSERVATIONS_DIR}`);
		return done;
	} finally {
		process.off("SIGINT", onSigint);
		server?.stop();
	}
}
