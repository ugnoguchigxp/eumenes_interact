import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPlaywrightMcpAdapter } from "eumenes-interact/adapters/playwright-mcp";
import { loadCases } from "../cases/load.ts";
import { CliApprover, FixtureApprover } from "../host/approval.ts";
import { runExperiment, type TrialFactories } from "../host/experiment.ts";
import { startFixtureServer } from "../host/fixture-server.ts";
import { createLarmInference } from "../inference/index.ts";
import type { LabLogger } from "../host/log.ts";
import { selectCases } from "../host/plan.ts";
import { getSetting } from "../host/store.ts";
import { collectVersions } from "../host/versions.ts";
import { createScriptedInference } from "../scripted/inference.ts";
import { loadScript } from "../scripted/script.ts";
import { playwrightLaunch } from "./launch.ts";

export type RunOptions = {
	caseId?: string;
	split?: "dev" | "holdout";
	includeHoldout: boolean;
	repeat: number;
	inference: "scripted" | "larm";
	approver: "fixture" | "cli";
	headed: boolean;
	browser?: string;
	executablePath?: string;
};

/** Real inference and holdout runs are the user's to start (plan.md §10.2, §10.5): say so on every one. */
export function notices(options: RunOptions, holdout: boolean): string[] {
	return [
		...(options.inference === "larm"
			? [
					"notice: --inference larm calls the real LARM; start it only when you have decided to (user-triggered, plan §10.5).",
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
			port: createScriptedInference(await loadScript(def.id)),
			info: () => ({ kind: "scripted" }),
			dispose: async () => {},
		});
	const baseUrl = getSetting(db, "larm.baseUrl");
	const profile = getSetting(db, "larm.profile");
	const token = process.env.LARM_API_TOKEN;
	if (!baseUrl || !profile)
		throw new Error("larm_not_configured: run `larm set` first");
	if (!token) throw new Error("larm_token_missing: set LARM_API_TOKEN");
	return async (def) => {
		const inference = createLarmInference({
			settings: { baseUrl, profile },
			token,
			clientId: randomUUID(),
			logger,
			correlationId: def.id,
		});
		return {
			port: inference,
			info: () => ({ kind: "larm", ...inference.describe() }),
			dispose: () => inference.close(),
		};
	};
}

export async function runCommand(
	db: Database,
	options: RunOptions,
	logger: LabLogger,
) {
	const all = await loadCases({ includeHoldout: options.includeHoldout });
	const cases = selectCases(all, options);
	const holdout = cases.some((c) => c.split === "holdout");
	// A missing script is found before anything starts.
	if (options.inference === "scripted")
		for (const def of cases) await loadScript(def.id);
	for (const line of notices(options, holdout)) console.error(line);
	const inference = inferenceFactory(db, options, logger);
	const server = startFixtureServer();
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
			arms: ["arm0"],
			repetitions: options.repeat,
			name: options.caseId ?? options.split ?? "run",
			inferenceKind: options.inference,
			includesHoldout: holdout,
			logger,
			versions: collectVersions({
				browser: {
					channel: options.browser ?? null,
					customExecutable: options.executablePath !== undefined,
					headless: !options.headed,
				},
			}),
			fixtureBaseUrl: server.baseUrl,
			onControl: (control) => {
				current = control;
			},
			onTrial: (result, def) =>
				console.log(
					[
						def.id,
						result.status,
						result.score.success ? "success" : "failure",
						result.score.failures.join(",") || "-",
					].join("\t"),
				),
			factories: {
				inference,
				approver: (def) =>
					options.approver === "cli"
						? new CliApprover()
						: new FixtureApprover(def.approvalScript),
				adapter: async () => {
					const workDir = await mkdtemp(join(tmpdir(), "interact-lab-"));
					const adapter = createPlaywrightMcpAdapter({
						launch: playwrightLaunch({
							...(options.browser ? { channel: options.browser } : {}),
							...(options.executablePath
								? { executablePath: options.executablePath }
								: {}),
						}),
						workDir,
						logger,
						correlationId: randomUUID(),
						browser: { mode: "isolated", headless: !options.headed },
					});
					return {
						adapter,
						dispose: async () => {
							await adapter.close();
							await rm(workDir, { recursive: true, force: true });
						},
					};
				},
			},
		});
		console.log(`experiment\t${done.experimentId}`);
		return done;
	} finally {
		process.off("SIGINT", onSigint);
		server.stop();
	}
}
