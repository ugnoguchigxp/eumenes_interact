import { parseArgs } from "node:util";
import {
	DEFAULT_KEEP_OPEN_IDLE_S,
	DEFAULT_KEEP_OPEN_MAX_S,
	chainCommand,
} from "./chain-command.ts";
import { loadCases } from "../cases/load.ts";
import { DEFAULT_DB_PATH, openLabDb } from "../host/db.ts";
import { acquireRunLock } from "../host/lock.ts";
import { createPinoLogger } from "../host/log.ts";
import { reconcileOnStartup } from "../host/reconcile.ts";
import { LAB_OWNER } from "../host/run.ts";
import { getSetting, setSetting } from "../host/store.ts";
import { listLarmChatProfiles } from "../inference/index.ts";
import { report, trialLines } from "./report.ts";
import { parseArm } from "./arm.ts";
import { DEFAULT_PLATFORM, parsePlatform } from "./platform.ts";
import { operateCommand } from "./operate-command.ts";
import { compareCommand } from "./compare-command.ts";
import { knowledgeImport, knowledgeList } from "./knowledge-command.ts";
import { runCommand } from "./run-command.ts";
import { parseInputs, taskList, taskRun } from "./task-command.ts";

const USAGE = `usage: bun lab/cli/main.ts <command> [options]
  cases [--include-holdout] [--include-live]
  run --case <id> | --split dev|holdout|live [--repeat n] [--inference scripted|larm|claude|manual]
      [--model <id>] [--effort low|medium|high|xhigh|max] [--max-tokens <n>] [--approver fixture|cli] [--include-holdout] [--include-live]
      [--arm arm1] [--capture-dir <abs dir>]
      [--keep-observations] [--headless] [--platform playwright-mcp]
      [--browser <channel>] [--executable-path <path>]
  task list
  task run <definitionId> --input key=value ... [--json] [--approver stop|cli] [--capture-dir <abs dir>]
      [--keep-observations] [--headless] [--platform playwright-mcp]
      [--browser <channel>] [--executable-path <path>]
  compare [--platforms playwright-mcp] [--definitions <id,...|all|none>]
      [--inputs <file.json>] [--repeat n] [--headless] [--split dev] [--include-live] [--keep-observations]
      [--approver stop|cli] [--inference scripted|claude] [--model <id>] [--effort <e>] [--max-tokens <n>]
      [--arm arm1] [--capture-dir <abs dir>]
  operate --request "<text>" --start-url <https url> --allow-origin <origin> [--allow-origin ...]
      [--inference claude|larm] [--model <id>] [--effort low|medium|high|xhigh|max] [--max-tokens <n>] [--max-calls n]
      [--arm arm1|arm0] [--capture-dir <abs dir>]
      [--approver stop|cli] [--headless] [--keep-observations] [--json]
  knowledge import <seed.json>...
  chain --request "<several steps in one sentence>" --inference manual [--keep-open-idle <s>] [--keep-open-max <s>]
      [--capture-dir <abs dir>] [--keep-observations] [--headless] [--browser <channel>]
      plans the request into at most 5 steps and runs them on one browser; a step whose result is the
      screen (再生/表示) keeps the browser open after the steps until you type 完了/done on stdin, stdin
      closes, --keep-open-idle seconds (default 3600) pass with no input while the video is not advancing,
      or --keep-open-max seconds (default 14400) pass. LAB_MANUAL_DIR is required (manual inference).
  knowledge list [--origin <origin>]
  trials [--experiment <id>]
  report --experiment <id>
  larm profiles [--base-url <url>]
  larm set --base-url <url> --profile <name>
global: --db <path>   (default lab/data/interact.sqlite)
The browser is headed (window shown) by default; --headless opts out. --headed is accepted and changes nothing.
The LARM token is read from LARM_API_TOKEN and is never stored.`;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		db: { type: "string" },
		case: { type: "string" },
		split: { type: "string" },
		repeat: { type: "string" },
		inference: { type: "string" },
		approver: { type: "string" },
		"include-holdout": { type: "boolean" },
		"include-live": { type: "boolean" },
		"keep-observations": { type: "boolean" },
		headed: { type: "boolean" },
		headless: { type: "boolean" },
		browser: { type: "string" },
		"executable-path": { type: "string" },
		experiment: { type: "string" },
		"base-url": { type: "string" },
		profile: { type: "string" },
		input: { type: "string", multiple: true },
		request: { type: "string" },
		"start-url": { type: "string" },
		"allow-origin": { type: "string", multiple: true },
		model: { type: "string" },
		effort: { type: "string" },
		"max-tokens": { type: "string" },
		arm: { type: "string" },
		"capture-dir": { type: "string" },
		"max-calls": { type: "string" },
		"keep-open-idle": { type: "string" },
		"keep-open-max": { type: "string" },
		json: { type: "boolean" },
		origin: { type: "string" },
		platform: { type: "string" },
		platforms: { type: "string" },
		definitions: { type: "string" },
		inputs: { type: "string" },
	},
});

const oneOf = <T extends string>(
	name: string,
	value: string | undefined,
	allowed: readonly T[],
	fallback: T,
): T => {
	if (value === undefined) return fallback;
	if ((allowed as readonly string[]).includes(value)) return value as T;
	throw new Error(`invalid_${name}:${value}`);
};

async function larmProfiles(baseUrl: string) {
	const token = process.env.LARM_API_TOKEN;
	if (!token) throw new Error("larm_token_missing: set LARM_API_TOKEN");
	return listLarmChatProfiles({
		baseUrl,
		token,
		signal: AbortSignal.timeout(15_000),
	});
}

async function main(): Promise<number> {
	const [command, sub, ...rest] = positionals;
	if (command === "cases") {
		for (const c of await loadCases({
			includeHoldout: values["include-holdout"] === true,
			includeLive: values["include-live"] === true,
		}))
			console.log(
				[c.id, c.split, c.category, c.variant, c.budget.maxModelCalls].join(
					"\t",
				),
			);
		return 0;
	}
	if (command === "operate")
		return operateCommand(values, values.json === true);
	if (
		![
			"run",
			"chain",
			"task",
			"compare",
			"knowledge",
			"trials",
			"report",
			"larm",
		].includes(command ?? "")
	) {
		console.error(USAGE);
		return 2;
	}
	// Refused before a lock or a database is touched.
	const platform = parsePlatform(values.platform);
	const dbPath = values.db ?? DEFAULT_DB_PATH;
	// Only a command that runs a browser session takes the lock and reconciles: another process's run in
	// progress must not be touched by a read-only command.
	const runs =
		command === "run" ||
		command === "chain" ||
		command === "compare" ||
		(command === "task" && sub === "run");
	const lock = runs ? acquireRunLock(`${dbPath}.run.lock`) : null;
	// A signal handler that exits (chain's kept browser) skips the finally below; the lock goes with the process.
	if (lock) process.once("exit", () => lock.release());
	let db: ReturnType<typeof openLabDb>;
	try {
		db = openLabDb(dbPath);
	} catch (error) {
		lock?.release();
		throw error;
	}
	const logger = runs ? createPinoLogger() : null;
	try {
		if (logger) {
			const settled = reconcileOnStartup(db, LAB_OWNER, logger);
			if (settled.indeterminateRuns.length || settled.abandonedRuns.length)
				console.error(
					`reconciled: ${settled.indeterminateRuns.length} indeterminate, ${settled.abandonedRuns.length} abandoned run(s); nothing was re-sent`,
				);
		}
		switch (command) {
			case "task": {
				if (sub === "list") {
					for (const line of await taskList()) console.log(line);
					return 0;
				}
				const [definitionId] = rest;
				if (sub !== "run" || !definitionId) {
					console.error(USAGE);
					return 2;
				}
				return await taskRun(
					db,
					{
						definitionId,
						inputs: parseInputs(values.input ?? []),
						json: values.json === true,
						keepObservations: values["keep-observations"] === true,
						approver: oneOf<"stop" | "cli">(
							"approver",
							values.approver,
							["stop", "cli"],
							"stop",
						),
						headed: values.headless !== true,
						platform,
						...(values["capture-dir"] === undefined
							? {}
							: { captureDir: values["capture-dir"] }),
						...(values.browser === undefined
							? {}
							: { browser: values.browser }),
						...(values["executable-path"] === undefined
							? {}
							: { executablePath: values["executable-path"] }),
					},
					logger!,
				);
			}
			case "compare": {
				const repeat = Number(values.repeat ?? "1");
				if (!Number.isInteger(repeat) || repeat < 1)
					throw new Error("invalid_repeat");
				return await compareCommand(
					db,
					{
						platforms: values.platforms ?? DEFAULT_PLATFORM,
						...(values.definitions === undefined
							? {}
							: { definitions: values.definitions }),
						...(values.inputs === undefined
							? {}
							: { inputsFile: values.inputs }),
						repeat,
						headed: values.headless !== true,
						...(values.split === undefined ? {} : { split: values.split }),
						includeLive: values["include-live"] === true,
						keepObservations: values["keep-observations"] === true,
						approver: oneOf<"stop" | "cli">(
							"approver",
							values.approver,
							["stop", "cli"],
							"stop",
						),
						inference: oneOf<"scripted" | "claude">(
							"inference",
							values.inference,
							["scripted", "claude"],
							"scripted",
						),
						...(values.model === undefined ? {} : { model: values.model }),
						...(values.effort === undefined ? {} : { effort: values.effort }),
						...(values["max-tokens"] === undefined
							? {}
							: { maxTokens: values["max-tokens"] }),
						arm: parseArm(values.arm, "arm1"),
						...(values["capture-dir"] === undefined
							? {}
							: { captureDir: values["capture-dir"] }),
					},
					logger!,
				);
			}
			case "knowledge": {
				if (sub === "import") {
					for (const line of await knowledgeImport(db, rest)) console.log(line);
					return 0;
				}
				if (sub === "list") {
					for (const line of knowledgeList(db, values.origin))
						console.log(line);
					return 0;
				}
				console.error(USAGE);
				return 2;
			}
			case "chain": {
				if (values.request === undefined)
					throw new Error("chain_needs_request");
				if ((values.inference ?? "manual") !== "manual")
					throw new Error("chain_inference_manual_only");
				const idle = Number(
					values["keep-open-idle"] ?? String(DEFAULT_KEEP_OPEN_IDLE_S),
				);
				if (!Number.isFinite(idle) || idle < 0)
					throw new Error("invalid_keep_open_idle");
				const max = Number(
					values["keep-open-max"] ?? String(DEFAULT_KEEP_OPEN_MAX_S),
				);
				if (!Number.isFinite(max) || max <= 0)
					throw new Error("invalid_keep_open_max");
				return await chainCommand(
					db,
					{
						request: values.request,
						inference: "manual",
						keepOpenIdleS: idle,
						keepOpenMaxS: max,
						headed: values.headless !== true,
						...(values.browser === undefined
							? {}
							: { browser: values.browser }),
						...(values["capture-dir"] === undefined
							? {}
							: { captureDir: values["capture-dir"] }),
						keepObservations: values["keep-observations"] === true,
					},
					logger!,
				);
			}
			case "run": {
				const repeat = Number(values.repeat ?? "1");
				if (!Number.isInteger(repeat) || repeat < 1)
					throw new Error("invalid_repeat");
				if ((values.case === undefined) === (values.split === undefined))
					throw new Error("give_exactly_one_of_case_or_split");
				const done = await runCommand(
					db,
					{
						...(values.case === undefined ? {} : { caseId: values.case }),
						...(values.split === undefined
							? {}
							: {
									split: oneOf<"dev" | "holdout" | "live">(
										"split",
										values.split,
										["dev", "holdout", "live"],
										"dev",
									),
								}),
						includeHoldout: values["include-holdout"] === true,
						includeLive: values["include-live"] === true,
						keepObservations: values["keep-observations"] === true,
						repeat,
						inference: oneOf(
							"inference",
							values.inference,
							["scripted", "larm", "claude", "manual"],
							"scripted",
						),
						...(values.model === undefined ? {} : { model: values.model }),
						...(values.effort === undefined ? {} : { effort: values.effort }),
						...(values["max-tokens"] === undefined
							? {}
							: { maxTokens: values["max-tokens"] }),
						arm: parseArm(values.arm, "arm1"),
						...(values["capture-dir"] === undefined
							? {}
							: { captureDir: values["capture-dir"] }),
						...(values.approver === undefined
							? {}
							: {
									approver: oneOf<"fixture" | "cli">(
										"approver",
										values.approver,
										["fixture", "cli"],
										"fixture",
									),
								}),
						headed: values.headless !== true,
						platform,
						...(values.browser === undefined
							? {}
							: { browser: values.browser }),
						...(values["executable-path"] === undefined
							? {}
							: { executablePath: values["executable-path"] }),
					},
					logger!,
				);
				return done.results.every((r) => r.score.success) ? 0 : 1;
			}
			case "trials":
				for (const line of trialLines(db, values.experiment)) console.log(line);
				return 0;
			case "report":
				if (!values.experiment) throw new Error("report_needs_experiment");
				console.log(JSON.stringify(report(db, values.experiment), null, 2));
				return 0;
			default: {
				if (sub === "profiles") {
					const baseUrl = values["base-url"] ?? getSetting(db, "larm.baseUrl");
					if (!baseUrl) throw new Error("larm_not_configured: give --base-url");
					for (const p of await larmProfiles(baseUrl))
						console.log(`${p.name}\t${p.description ?? ""}`);
					return 0;
				}
				if (sub === "set") {
					const baseUrl = values["base-url"];
					const profile = values.profile;
					if (!baseUrl || !profile)
						throw new Error("larm_set_needs_base_url_and_profile");
					if (!(await larmProfiles(baseUrl)).some((p) => p.name === profile))
						throw new Error("larm_profile_not_found");
					const nowIso = new Date().toISOString();
					setSetting(db, "larm.baseUrl", baseUrl, nowIso);
					setSetting(db, "larm.profile", profile, nowIso);
					console.log("saved (the token is not stored)");
					return 0;
				}
				console.error(USAGE);
				return 2;
			}
		}
	} finally {
		logger?.close();
		db.close();
		lock?.release();
	}
}

process.exitCode = await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	return 1;
});
// The work is done and the lock released: a handle left open (a stdin fifo, a browser connection) must not
// keep the process alive.
process.exit();
