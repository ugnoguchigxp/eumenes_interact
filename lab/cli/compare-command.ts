import type { Database } from "bun:sqlite";
import type { ArmId } from "eumenes-interact";
import { loadCases } from "../cases/load.ts";
import type { CaseDef } from "../cases/schema.ts";
import {
	buildReport,
	loadCompareInputs,
	planCompare,
	runCompare,
	writeReport,
	type Sample,
} from "../host/compare.ts";
import { CliApprover } from "../host/approval.ts";
import {
	claudeSettings,
	ensureClaudeCredential,
	startClaude,
} from "../host/claude.ts";
import { loadDefinitions } from "../host/definitions.ts";
import { startFixtureServer } from "../host/fixture-server.ts";
import type { LabLogger } from "../host/log.ts";
import {
	DEFAULT_OBSERVATIONS_DIR,
	createObservationSink,
	pruneObservations,
} from "../host/observations.ts";
import { DEFAULT_CAPTURES_DIR } from "../host/parts/capture.ts";
import { LAB_OWNER } from "../host/run.ts";
import { packageCommit } from "../host/versions.ts";
import { importSeed, loadSeeds } from "../knowledge/seed.ts";
import { parsePlatform, type BrowserPlatform } from "./platform.ts";
import { checkArmInference, parseCaptureDir } from "./arm.ts";
import { createSession } from "./session.ts";

export type CompareOptions = {
	platforms: string;
	/** `all`, `none` or ids separated by commas. Default `all`. */
	definitions?: string;
	inputsFile?: string;
	repeat: number;
	headed: boolean;
	split?: string;
	includeLive: boolean;
	keepObservations: boolean;
	/** For definition runs: `stop` (default) never grants, `cli` asks on the terminal. */
	approver?: "stop" | "cli";
	/** What answers the fixture cases of `--split dev`: the scripted files (default) or Claude. */
	inference?: "scripted" | "claude";
	model?: string;
	effort?: string;
	maxTokens?: string;
	/** `arm1` (registered parts), for the fixture cases. */
	arm?: ArmId;
	/** Arm 1: where the cases' screenshots go (an existing absolute directory); default: `lab/data/captures/<runId>/`. */
	captureDir?: string;
};

/** The platforms of `--platforms a,b`, each valid and none twice. */
export function parsePlatforms(value: string): BrowserPlatform[] {
	const platforms = value.split(",").map((p) => parsePlatform(p.trim()));
	if (platforms.length < 1 || new Set(platforms).size !== platforms.length)
		throw new Error("platforms_must_be_distinct");
	return platforms;
}

/**
 * `compare`: the same work on each platform, interleaved, then a JSON and a Markdown report. Definitions visit
 * real sites, so they need `--include-live`; `--split dev` adds the scripted Arm 0 fixture cases.
 */
export async function compareCommand(
	db: Database,
	options: CompareOptions,
	logger: LabLogger,
): Promise<number> {
	const platforms = parsePlatforms(options.platforms);
	if (options.split !== undefined && options.split !== "dev")
		throw new Error("compare_split_must_be_dev");
	const known = await loadDefinitions();
	const wanted =
		options.definitions === undefined || options.definitions === "all"
			? known.map((d) => d.definition.id)
			: options.definitions === "none"
				? []
				: options.definitions.split(",").map((s) => s.trim());
	const byId = new Map(known.map((d) => [d.definition.id, d.definition]));
	for (const id of wanted)
		if (!byId.has(id)) throw new Error(`definition_not_found:${id}`);
	if (wanted.length > 0 && !options.includeLive)
		throw new Error("live_needs_include_live: definitions visit real sites");
	const inputs = await loadCompareInputs(options.inputsFile);
	for (const id of wanted)
		if (!inputs[id]) throw new Error(`no_inputs_for:${id}`);
	if (
		options.inference !== "claude" &&
		(options.model || options.effort || options.maxTokens)
	)
		throw new Error("model_and_effort_are_for_claude");
	const arm = options.arm ?? "arm1";
	checkArmInference(arm, options.inference ?? "scripted");
	const captureDir = parseCaptureDir(options.captureDir);
	// Frozen for the whole comparison and checked before anything is opened.
	const claude =
		options.inference === "claude" ? claudeSettings(options) : null;
	if (claude) ensureClaudeCredential();
	const cases: CaseDef[] =
		options.split === "dev" ? await loadCases({ includeHoldout: false }) : [];
	const items = planCompare({
		platforms,
		definitions: wanted.map((id) => ({
			id,
			needsHeaded: inputs[id]!.needsHeaded === true,
			inputs: inputs[id]!.inputs,
		})),
		caseIds: cases.map((c) => c.id),
		repeat: options.repeat,
		headed: options.headed,
	});
	console.error(
		"notice: compare drives real browsers on real sites; start it only when you have decided to (user-triggered, plan §10.2).",
	);
	if (claude)
		console.error(
			"notice: --inference claude calls the Claude API with the key in your .env and costs money (user-triggered, plan §10.5).",
		);
	const nowIso = new Date().toISOString();
	for (const { seed } of await loadSeeds())
		importSeed(db, LAB_OWNER, seed, nowIso);
	// Observation bodies of earlier runs that outlived their week go first (plan.md §14).
	await pruneObservations(DEFAULT_OBSERVATIONS_DIR, Date.now());
	await pruneObservations(DEFAULT_CAPTURES_DIR, Date.now());
	const abort = new AbortController();
	const onSigint = () => abort.abort();
	process.on("SIGINT", onSigint);
	const server = cases.length > 0 ? startFixtureServer() : null;
	try {
		const samples = await runCompare({
			db,
			logger,
			items,
			definitions: byId,
			cases: new Map(cases.map((c) => [c.id, c])),
			createSession: (platform) =>
				createSession(
					{ headed: options.headed, platform: platform as BrowserPlatform },
					logger,
				),
			commit: packageCommit(),
			inferenceKind: claude ? "claude" : "scripted",
			inferenceLabel: claude
				? `claude:${claude.model}/${claude.effort}`
				: "scripted",
			...(claude ? { frozenInference: claude } : {}),
			arm,
			...(captureDir ? { captureDir } : {}),
			...(claude
				? {
						inference: async (def: CaseDef) =>
							startClaude(claude, logger, def.id),
					}
				: {}),
			...(options.approver === "cli"
				? { approver: () => new CliApprover() }
				: {}),
			...(server ? { fixtureBaseUrl: server.baseUrl } : {}),
			...(options.keepObservations
				? { observationSink: createObservationSink(DEFAULT_OBSERVATIONS_DIR) }
				: {}),
			signal: abort.signal,
			onSample: (s: Sample) =>
				console.log(
					[
						`#${s.order}`,
						s.platform,
						s.target,
						s.skipped ??
							(s.ok ? "ok" : `not ok (${s.failures.join(",") || s.status})`),
						`${s.durationMs}ms`,
					].join("\t"),
				),
		});
		const report = buildReport(
			{
				platforms,
				repeat: options.repeat,
				headed: options.headed,
				definitions: wanted,
				cases: cases.map((c) => c.id),
				arm,
				inference: claude
					? `claude:${claude.model}/${claude.effort}`
					: "scripted",
			},
			samples,
			new Date().toISOString(),
		);
		const paths = writeReport(report);
		console.log(`report\t${paths.md}`);
		console.log(`json\t${paths.json}`);
		if (options.keepObservations)
			console.log(`observations\t${DEFAULT_OBSERVATIONS_DIR}`);
		return samples.every((s) => s.skipped !== null || s.ok) ? 0 : 1;
	} finally {
		process.off("SIGINT", onSigint);
		server?.stop();
	}
}
