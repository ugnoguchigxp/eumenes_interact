import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ArmId,
	InferencePort,
	PlatformAdapter,
	WorkDefinition,
} from "eumenes-interact";
import { z } from "zod";
import type { CaseDef } from "../cases/schema.ts";
import { median } from "../scorer/aggregate.ts";
import {
	createArm1ScriptedInference,
	loadArm1Script,
} from "../scripted/arm1.ts";
import { FixtureApprover, printable, type Approver } from "./approval.ts";
import { collabScriptedAgent } from "./collab.ts";
import {
	aggregateUsage,
	inferenceLabel,
	noCalls,
	trialUsage,
	UNKNOWN_USAGE,
	type TrialUsage,
	type UsageRow,
} from "./usage.ts";
import type { InferenceInfo, InferenceKind } from "./types.ts";
import { RunControl } from "./control.ts";
import { runDefinition } from "./definition-run.ts";
import type { LabLogger } from "./log.ts";
import type { ObservationSink } from "./observations.ts";
import { runTrial } from "./run.ts";
import { createExperiment } from "./store.ts";
import { collectVersions } from "./versions.ts";

/**
 * Compares platforms on the same work (plan.md §10.3, §10.4): each work definition with each input, and
 * optionally the scripted Arm 0 fixture cases, on every platform, repeated, the platform that goes first
 * alternating. What is compared is how big the platform's snapshot is, how fast the run is and how often it
 * works, not what a page said: a report holds lengths and a short head of the extract (marked as page data),
 * never the extract text.
 */

export const DEFAULT_COMPARE_INPUTS = fileURLToPath(
	new URL("../compare/inputs.json", import.meta.url),
);
export const DEFAULT_REPORT_DIR = fileURLToPath(
	new URL("../data/reports", import.meta.url),
);

/** Per definition: the inputs to run it with, and whether the site only works in a headed browser. */
export const compareInputsSchema = z.record(
	z.string(),
	z.strictObject({
		needsHeaded: z.boolean().optional(),
		inputs: z.array(z.record(z.string(), z.string())).min(1),
	}),
);
export type CompareInputs = z.infer<typeof compareInputsSchema>;

export async function loadCompareInputs(
	path: string = DEFAULT_COMPARE_INPUTS,
): Promise<CompareInputs> {
	return compareInputsSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export type CompareItem =
	| {
			kind: "definition";
			platform: string;
			target: string;
			input: Record<string, string>;
			repetition: number;
			/** Why it is not run (reported, not hidden). */
			skip?: string;
	  }
	| {
			kind: "case";
			platform: string;
			target: string;
			repetition: number;
	  };

export type ComparePlan = {
	platforms: readonly string[];
	definitions: readonly {
		id: string;
		needsHeaded: boolean;
		inputs: readonly Record<string, string>[];
	}[];
	caseIds: readonly string[];
	repeat: number;
	headed: boolean;
};

/**
 * The runs in order. A unit of work is one definition with one input, or one case; in each repetition every
 * platform runs it once, and the platform that goes first is rotated from unit to unit and from repetition to
 * repetition so none is always first (plan.md §10.4). A site that needs a headed browser is planned as
 * skipped when the run is headless.
 */
export function planCompare(plan: ComparePlan): CompareItem[] {
	const n = plan.platforms.length;
	const units: ((platform: string, repetition: number) => CompareItem)[] = [
		...plan.definitions.flatMap((d) =>
			d.inputs.map(
				(input) =>
					(platform: string, repetition: number): CompareItem => ({
						kind: "definition",
						platform,
						target: d.id,
						input,
						repetition,
						...(d.needsHeaded && !plan.headed
							? { skip: "skipped: needs --headed" }
							: {}),
					}),
			),
		),
		...plan.caseIds.map(
			(id) =>
				(platform: string, repetition: number): CompareItem => ({
					kind: "case",
					platform,
					target: id,
					repetition,
				}),
		),
	];
	const items: CompareItem[] = [];
	for (let repetition = 1; repetition <= plan.repeat; repetition++)
		units.forEach((unit, k) => {
			for (let j = 0; j < n; j++)
				items.push(
					unit(plan.platforms[(repetition - 1 + k + j) % n]!, repetition),
				);
		});
	return items;
}

/** One run, reduced to what the comparison reads. */
export type Sample = {
	order: number;
	platform: string;
	kind: "definition" | "case";
	target: string;
	input: Record<string, string> | null;
	repetition: number;
	skipped: string | null;
	ok: boolean;
	status: string;
	code: string | null;
	/** Failure classes: a definition's code, a case's score failures. */
	failures: string[];
	/** Wall clock of the whole run, the browser's cold start included. */
	durationMs: number;
	/** Per observation: the platform's snapshot bytes and refs, and what the model was shown (Arm 0). */
	observationBytes: number[];
	observationRefs: number[];
	shapedBytes: number[];
	extractChars: number[];
	/** Clicks and submitted fills that were confirmed and left the URL unchanged. */
	urlUnchanged: number;
	tool: { name: string; version: string | null } | null;
	/** The length of the first extract and a short head of it, which is page data and nothing more. */
	preview: { charCount: number; head: string } | null;
	/** What answered a case (`scripted`, `claude:<model>/<effort>`…) and what its model calls took; null for a definition. */
	inference: string | null;
	usage: TrialUsage | null;
};

const PREVIEW_CHARS = 80;

const blank = (): Omit<
	Sample,
	"order" | "platform" | "kind" | "target" | "input" | "repetition"
> => ({
	skipped: null,
	ok: false,
	status: "not_run",
	code: null,
	failures: [],
	durationMs: 0,
	observationBytes: [],
	observationRefs: [],
	shapedBytes: [],
	extractChars: [],
	urlUnchanged: 0,
	tool: null,
	preview: null,
	inference: null,
	usage: null,
});

export type RunCompareOptions = {
	db: Database;
	logger: LabLogger;
	items: readonly CompareItem[];
	definitions: ReadonlyMap<string, WorkDefinition>;
	cases: ReadonlyMap<string, CaseDef>;
	/** A fresh session on the platform; the run closes it. */
	createSession(
		platform: string,
	): Promise<{ adapter: PlatformAdapter; dispose(): Promise<void> }>;
	/** The kind of inference answering the cases (frozen into each platform's experiment); default `scripted`. */
	inferenceKind?: InferenceKind;
	/** The model and effort a Claude comparison is frozen to. */
	frozenInference?: { model: string; effort: string; maxTokens?: number };
	/** The label of what answers the cases (`scripted`, `claude:<model>/<effort>`), known before any run. */
	inferenceLabel?: string;
	/** `arm1` (registered parts); frozen into each platform's experiment. */
	arm?: ArmId;
	/** Arm 1: an existing absolute directory the cases' screenshots go to; default: the lab's area per run. */
	captureDir?: string;
	/** Where the default capture directories are made (tests). */
	captureRoot?: string;
	/** What answers a case's model calls; default: the scripted inference. Definitions use no model. */
	inference?: (
		def: CaseDef,
		arm: ArmId,
	) => Promise<{
		port: InferencePort;
		info: () => InferenceInfo;
		dispose(): Promise<void>;
	}>;
	/** The approver of a definition run; default: one that never grants (`StopApprover`). */
	approver?: () => Approver;
	/** The repository's commit for the trial records (null when unknown). */
	commit?: string | null;
	/** The fixture server's base, when cases are run. */
	fixtureBaseUrl?: string;
	observationSink?: ObservationSink;
	now?: () => number;
	/** Stops the remaining runs (a cancel). */
	signal?: AbortSignal;
	onSample?: (sample: Sample) => void;
};

/** Runs the plan, one run at a time, and returns what each came to. */
export async function runCompare(
	options: RunCompareOptions,
): Promise<Sample[]> {
	const now = options.now ?? Date.now;
	const samples: Sample[] = [];
	const experiments = new Map<string, string>();
	const experimentFor = (platform: string) => {
		let id = experiments.get(platform);
		if (id === undefined) {
			id = `compare-${platform}-${crypto.randomUUID()}`;
			createExperiment(options.db, {
				id,
				name: `compare ${platform}`,
				caseIds: [...options.cases.keys()],
				caseDigest: "compare",
				includesHoldout: false,
				repetitions: 1,
				arms: [options.arm ?? "arm1"],
				budget: {
					inference: {
						kind: options.inferenceKind ?? "scripted",
						...options.frozenInference,
					},
				},
				inferenceKind: options.inferenceKind ?? "scripted",
				nowIso: new Date(now()).toISOString(),
			});
			experiments.set(platform, id);
		}
		return id;
	};
	const label = options.inferenceLabel ?? "scripted";
	let order = 0;
	for (const item of options.items) {
		if (options.signal?.aborted) break;
		const base = {
			order: order++,
			platform: item.platform,
			kind: item.kind,
			target: item.target,
			input: item.kind === "definition" ? item.input : null,
			repetition: item.repetition,
		};
		let sample: Sample;
		if (item.kind === "definition" && item.skip) {
			sample = { ...blank(), ...base, skipped: item.skip };
		} else {
			const began = now();
			let session: Awaited<ReturnType<RunCompareOptions["createSession"]>>;
			try {
				session = await options.createSession(item.platform);
			} catch {
				sample = {
					...blank(),
					...base,
					status: "error",
					code: "session_unavailable",
					failures: ["session_unavailable"],
					// A case that never started made no model call: it counts as a failed trial, at no cost.
					...(item.kind === "case"
						? {
								inference: label,
								usage: noCalls(label.startsWith("claude:")),
							}
						: {}),
				};
				samples.push(sample);
				options.onSample?.(sample);
				continue;
			}
			const control = new RunControl();
			const onAbort = () => control.cancel("cancel");
			options.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				sample =
					item.kind === "definition"
						? await definitionSample(
								options,
								item,
								session.adapter,
								control,
								base,
								began,
							)
						: await caseSample(
								options,
								item,
								session.adapter,
								control,
								base,
								began,
								experimentFor(item.platform),
							);
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
				await session.dispose();
			}
		}
		samples.push(sample);
		options.onSample?.(sample);
	}
	return samples;
}

async function definitionSample(
	options: RunCompareOptions,
	item: Extract<CompareItem, { kind: "definition" }>,
	adapter: PlatformAdapter,
	control: RunControl,
	base: Pick<
		Sample,
		"order" | "platform" | "kind" | "target" | "input" | "repetition"
	>,
	began: number,
): Promise<Sample> {
	const now = options.now ?? Date.now;
	const definition = options.definitions.get(item.target);
	if (!definition) throw new Error(`definition_not_found:${item.target}`);
	const result = await runDefinition({
		db: options.db,
		definition,
		inputs: item.input,
		adapter,
		logger: options.logger,
		...(options.approver ? { approver: options.approver() } : {}),
		control,
		...(options.now ? { now: options.now } : {}),
		...(options.observationSink
			? { observationSink: options.observationSink }
			: {}),
	});
	const firstExtract = Object.values(result.extracts)[0];
	return {
		...blank(),
		...base,
		ok: result.ok,
		status: result.status,
		code: result.code,
		failures: result.ok ? [] : [result.code ?? result.status],
		durationMs: now() - began,
		observationBytes: result.steps.flatMap((s) =>
			s.bodyBytes === undefined ? [] : [s.bodyBytes],
		),
		observationRefs: result.steps.flatMap((s) =>
			s.refCount === undefined ? [] : [s.refCount],
		),
		extractChars: result.steps.flatMap((s) =>
			s.charCount === undefined ? [] : [s.charCount],
		),
		urlUnchanged: result.steps.filter((s) => s.urlChanged === false).length,
		tool: result.tool,
		preview: firstExtract
			? {
					charCount: firstExtract.charCount,
					head: printable(firstExtract.text, PREVIEW_CHARS),
				}
			: null,
	};
}

async function caseSample(
	options: RunCompareOptions,
	item: Extract<CompareItem, { kind: "case" }>,
	adapter: PlatformAdapter,
	control: RunControl,
	base: Pick<
		Sample,
		"order" | "platform" | "kind" | "target" | "input" | "repetition"
	>,
	began: number,
	experimentId: string,
): Promise<Sample> {
	const now = options.now ?? Date.now;
	const def = options.cases.get(item.target);
	if (!def) throw new Error(`case_not_found:${item.target}`);
	const arm = options.arm ?? "arm1";
	const inference = options.inference
		? await options.inference(def, arm)
		: {
				port: collabScriptedAgent(
					createArm1ScriptedInference(await loadArm1Script(def.id)),
				),
				info: (): InferenceInfo => ({ kind: "scripted" }),
				dispose: async () => {},
			};
	let result: Awaited<ReturnType<typeof runTrial>>;
	try {
		result = await runTrial({
			db: options.db,
			def,
			arm,
			experimentId,
			repetition: item.repetition,
			orderIndex: base.order,
			adapter,
			inference: inference.port,
			inferenceInfo: inference.info,
			approver: new FixtureApprover(def.approvalScript),
			logger: options.logger,
			versions: collectVersions({
				browser: { channel: null, customExecutable: false, headless: true },
				commit: options.commit ?? null,
			}),
			...(options.fixtureBaseUrl
				? { fixtureBaseUrl: options.fixtureBaseUrl }
				: {}),
			...(options.observationSink
				? { observationSink: options.observationSink }
				: {}),
			...(options.captureDir ? { captureDir: options.captureDir } : {}),
			...(options.captureRoot ? { captureRoot: options.captureRoot } : {}),
			control,
			...(options.now ? { now: options.now } : {}),
		});
	} finally {
		await inference.dispose();
	}
	const observed = result.transcript.events.flatMap((e) =>
		e.type === "observation" ? [e] : [],
	);
	return {
		...blank(),
		...base,
		ok: result.score.success,
		status: result.status,
		code: result.code,
		failures: result.score.success ? [] : result.score.failures,
		durationMs: now() - began,
		observationBytes: observed.flatMap((e) =>
			e.bodyBytes === undefined ? [] : [e.bodyBytes],
		),
		observationRefs: observed.map((e) => e.refCount),
		shapedBytes: observed.flatMap((e) =>
			e.shapedBytes === undefined ? [] : [e.shapedBytes],
		),
		tool: adapter.toolInfo(),
		inference: inferenceLabel(inference.info()),
		usage: trialUsage(result.transcript, inference.info()),
	};
}

export type Row = {
	platform: string;
	/** A definition or case id; `ALL` for a platform's summary. */
	target: string;
	runs: number;
	skipped: number;
	ok: number;
	okRate: number | null;
	/** Over the runs that worked, like the other efficiency medians (plan.md §11); total is over every run. */
	medianMs: number | null;
	totalMs: number;
	medianObservationBytes: number | null;
	medianObservationRefs: number | null;
	medianShapedBytes: number | null;
	medianExtractChars: number | null;
	failureCodes: Record<string, number>;
	urlUnchanged: number;
	/** What answered the cases, and their tokens, model calls and estimated cost; null when no case ran. */
	inference: string | null;
	usage: UsageRow | null;
};

function row(
	platform: string,
	target: string,
	samples: readonly Sample[],
): Row {
	const ran = samples.filter((s) => s.skipped === null);
	const worked = ran.filter((s) => s.ok);
	const failureCodes: Record<string, number> = {};
	for (const s of ran)
		for (const code of s.failures)
			failureCodes[code] = (failureCodes[code] ?? 0) + 1;
	return {
		platform,
		target,
		runs: ran.length,
		skipped: samples.length - ran.length,
		ok: worked.length,
		okRate: ran.length === 0 ? null : worked.length / ran.length,
		medianMs: median(worked.map((s) => s.durationMs)),
		totalMs: ran.reduce((sum, s) => sum + s.durationMs, 0),
		medianObservationBytes: median(ran.flatMap((s) => s.observationBytes)),
		medianObservationRefs: median(ran.flatMap((s) => s.observationRefs)),
		medianShapedBytes: median(ran.flatMap((s) => s.shapedBytes)),
		medianExtractChars: median(ran.flatMap((s) => s.extractChars)),
		failureCodes,
		urlUnchanged: ran.reduce((sum, s) => sum + s.urlUnchanged, 0),
		inference: ran.find((s) => s.inference !== null)?.inference ?? null,
		usage: usageOf(ran),
	};
}

/**
 * The usage of the cases that ran, every one of them in the denominator, so the success rate here is the
 * main table's. A definition uses no model and has no usage.
 */
function usageOf(ran: readonly Sample[]): UsageRow | null {
	const cases = ran.filter((s) => s.kind === "case");
	return cases.length === 0
		? null
		: aggregateUsage(
				cases.map((s) => ({ success: s.ok, usage: s.usage ?? UNKNOWN_USAGE })),
			);
}

export type Aggregate = { perTarget: Row[]; perPlatform: Row[] };

/** Per platform and target, and per platform over everything it ran. */
export function aggregate(samples: readonly Sample[]): Aggregate {
	const platforms = [...new Set(samples.map((s) => s.platform))];
	const targets = [...new Set(samples.map((s) => s.target))];
	return {
		perPlatform: platforms.map((p) =>
			row(
				p,
				"ALL",
				samples.filter((s) => s.platform === p),
			),
		),
		perTarget: targets.flatMap((t) =>
			platforms.flatMap((p) => {
				const mine = samples.filter((s) => s.platform === p && s.target === t);
				return mine.length === 0 ? [] : [row(p, t, mine)];
			}),
		),
	};
}

export type CompareReport = {
	generatedAt: string;
	options: {
		platforms: readonly string[];
		/** What answered the cases: `scripted`, or `claude:<model>/<effort>`. */
		inference?: string;
		/** The arm the fixture cases ran on (`arm1` registered parts). */
		arm?: ArmId;
		repeat: number;
		headed: boolean;
		definitions: readonly string[];
		cases: readonly string[];
	};
	tools: Record<string, { name: string; version: string | null } | null>;
	summary: Aggregate;
	samples: Sample[];
};

export function buildReport(
	options: CompareReport["options"],
	samples: Sample[],
	generatedAt: string,
): CompareReport {
	const tools: CompareReport["tools"] = {};
	for (const p of options.platforms)
		tools[p] = samples.find((s) => s.platform === p && s.tool)?.tool ?? null;
	return { generatedAt, options, tools, summary: aggregate(samples), samples };
}

const fmt = (n: number | null, digits = 0) =>
	n === null ? "-" : n.toFixed(digits);
const pct = (n: number | null) =>
	n === null ? "-" : `${Math.round(n * 100)}%`;
const failures = (r: Row) =>
	Object.entries(r.failureCodes)
		.map(([code, n]) => `${code}×${n}`)
		.join(", ") || "-";
const cell = (text: string) => text.replaceAll("|", "\\|");

function table(rows: readonly Row[], first: "platform" | "target"): string[] {
	const head =
		"| platform | target | runs | ok | ok rate | median ms (ok) | total ms | median snapshot bytes | median refs | median shaped bytes | median extract chars | url unchanged | failures |";
	return [
		head,
		head.replace(/[^|]/g, "-"),
		...[...rows]
			.sort((a, b) =>
				first === "platform"
					? a.platform.localeCompare(b.platform)
					: a.target.localeCompare(b.target) ||
						a.platform.localeCompare(b.platform),
			)
			.map(
				(r) =>
					`| ${cell(r.platform)} | ${cell(r.target)} | ${r.runs} | ${r.ok} | ${pct(r.okRate)} | ${fmt(r.medianMs)} | ${fmt(r.totalMs)} | ${fmt(r.medianObservationBytes)} | ${fmt(r.medianObservationRefs)} | ${fmt(r.medianShapedBytes)} | ${fmt(r.medianExtractChars)} | ${r.urlUnchanged} | ${cell(failures(r))} |`,
			),
	];
}

const stat = (s: { total: number | null; median: number | null }) =>
	`${fmt(s.total)} / ${fmt(s.median)}`;
const usd = (n: number | null) => (n === null ? "-" : `$${n.toFixed(4)}`);

/** Tokens, model calls and the estimated cost, for the rows that ran a case with a model's answers. */
function usageTable(rows: readonly Row[]): string[] {
	const head =
		"| platform | target | inference | case trials | ok rate | model calls (total / median) | uncached input tokens (total / median) | output tokens | cache read tokens | cache write tokens | prompt total (input + cache) | cost estimate total | per trial | per successful trial |";
	return [
		head,
		head.replace(/[^|]/g, "-"),
		...rows.flatMap((r) =>
			r.usage === null
				? []
				: [
						`| ${cell(r.platform)} | ${cell(r.target)} | ${cell(r.inference ?? "-")} | ${r.usage.trials} | ${pct(r.usage.successRate)} | ${stat(r.usage.modelCalls)} | ${stat(r.usage.tokens.input)} | ${stat(r.usage.tokens.output)} | ${stat(r.usage.tokens.cacheRead)} | ${stat(r.usage.tokens.cacheWrite)} | ${stat(r.usage.tokens.promptTotal)} | ${usd(r.usage.costUsdEstimate.total)} | ${usd(r.usage.costUsdEstimate.perTrial)} | ${usd(r.usage.costUsdEstimate.perSuccess)} |`,
					],
		),
	];
}

/** The report for a person. Queries are the user's own sample inputs; the extract appears as a length and a short head only. */
export function markdown(report: CompareReport): string {
	const { options, summary, samples } = report;
	const lines = [
		`# Platform comparison ${report.generatedAt}`,
		"",
		`- platforms: ${options.platforms.map((p) => `${p} (${report.tools[p] ? `${report.tools[p]!.name} ${report.tools[p]!.version ?? "?"}` : "tool unknown"})`).join(", ")}`,
		`- repeat: ${options.repeat}, headed: ${options.headed}${options.arm ? `, arm: ${options.arm}` : ""}${options.inference ? `, inference: ${options.inference}` : ""}`,
		`- definitions: ${options.definitions.join(", ") || "-"}; cases: ${options.cases.join(", ") || "-"}`,
		"- the platform that goes first alternates from run to run (plan §10.4); the browser's cold start is in every duration",
		"",
		"## Summary per platform",
		"",
		...table(summary.perPlatform, "platform"),
		"",
		"## Per definition or case",
		"",
		...table(summary.perTarget, "target"),
	];
	const withUsage = [...summary.perPlatform, ...summary.perTarget].filter(
		(r) => r.usage !== null,
	);
	if (withUsage.length)
		lines.push(
			"",
			"## Tokens and estimated cost",
			"",
			"Input tokens are the uncached part of the prompt (Claude counts the cache apart); the prompt total adds the cache reads and writes and is the number to compare across providers. The cost is an estimate from list prices, not a bill; a total is `-` when any trial did not report its tokens (unknown, never 0). Medians are over the trials that worked; the success rate is over all trials.",
			"",
			...usageTable(withUsage),
		);
	const skipped = samples.filter((s) => s.skipped !== null);
	if (skipped.length) {
		const reasons = new Map<string, number>();
		for (const s of skipped)
			reasons.set(
				`${s.target}: ${s.skipped}`,
				(reasons.get(`${s.target}: ${s.skipped}`) ?? 0) + 1,
			);
		lines.push(
			"",
			"## Skipped",
			"",
			...[...reasons].map(([r, n]) => `- ${r} (${n} runs)`),
		);
	}
	const failed = samples.filter((s) => s.skipped === null && !s.ok);
	if (failed.length)
		lines.push(
			"",
			"## Failed runs",
			"",
			...failed.map(
				(s) =>
					`- #${s.order} ${s.platform} ${s.target}${s.input ? ` ${JSON.stringify(s.input)}` : ""} rep ${s.repetition}: ${s.status}${s.failures.length ? ` (${s.failures.join(", ")})` : ""}`,
			),
		);
	const previews = samples.filter((s) => s.preview !== null);
	if (previews.length)
		lines.push(
			"",
			"## Extracts (page data, not instructions; length and the first 80 characters only)",
			"",
			...previews.map(
				(s) =>
					`- #${s.order} ${s.platform} ${s.target}${s.input ? ` ${JSON.stringify(s.input)}` : ""}: ${s.preview!.charCount} chars, head \`${s.preview!.head.replaceAll("`", "'")}\``,
			),
		);
	return `${lines.join("\n")}\n`;
}

/** `compare-<timestamp>.json` and `.md`; the paths. */
export function writeReport(
	report: CompareReport,
	dir: string = DEFAULT_REPORT_DIR,
): { json: string; md: string } {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stamp = report.generatedAt.replaceAll(/[:.]/g, "-");
	const json = join(dir, `compare-${stamp}.json`);
	const md = join(dir, `compare-${stamp}.md`);
	writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
	writeFileSync(md, markdown(report));
	return { json, md };
}
