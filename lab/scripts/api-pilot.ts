/** Explicit paid pilot: identical synthetic Chrome fixtures, alternating providers, no retries. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadCases } from "../cases/load.ts";
import { asCollabAgent } from "../host/collab.ts";
import {
	startClaude,
	startLuna,
	ensureClaudeCredential,
	paidLedger,
} from "../host/claude.ts";
import { chainPlan } from "../host/chain.ts";
import { createExperiment } from "../host/store.ts";
import { openLabDb } from "../host/db.ts";
import { startFixtureServer } from "../host/fixture-server.ts";
import { createSession } from "../cli/session.ts";
import { FixtureApprover } from "../host/approval.ts";
import { runTrial } from "../host/run.ts";
import { collectVersions } from "../host/versions.ts";
import { silentLabLogger } from "../host/log.ts";
import type { InferenceOutcome } from "eumenes-interact";
const ALL_IDS = [
	"dev-search-base",
	"dev-select-delayed",
	"dev-form-base",
	"dev-approval-deny",
	"dev-clarify-form",
	"dev-capture-item",
	"dev-form-multifield-ask",
	"dev-read-table",
];
const selected = process.env.LAB_PILOT_CASES?.split(",");
const evaluationSplit = process.env.LAB_EVAL_SPLIT;
if (
	evaluationSplit &&
	evaluationSplit !== "dev" &&
	evaluationSplit !== "holdout"
)
	throw new Error("invalid_evaluation_split");
const cases = await loadCases({
	includeHoldout: evaluationSplit === "holdout",
});
const available = evaluationSplit
	? cases.filter((c) => c.split === evaluationSplit).map((c) => c.id)
	: ALL_IDS;
if (selected?.some((id) => !available.includes(id)))
	throw new Error("unknown_evaluation_case");
const IDS = selected
	? available.filter((id) => selected.includes(id))
	: available;
const files = [
	...new Set(
		Bun.spawnSync(["git", "ls-files", "-c", "-o", "--exclude-standard", "-z"])
			.stdout.toString()
			.split("\0"),
	),
]
	.filter((p) =>
		/^(lab\/(host|cli|inference|scorer|scripted|config|cases|fixtures)\/|packages\/eumenes-interact\/(src\/|package.json)|skills\/|vendor\/|bun.lock$|package.json$|tsconfig.json$)/.test(
			p,
		),
	)
	.sort();
const sourceFingerprint = createHash("sha256");
for (const file of files)
	sourceFingerprint.update(file + "\0").update(readFileSync(file));
const snapshot = {
	baseCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"])
		.stdout.toString()
		.trim(),
	sourceSha256: sourceFingerprint.digest("hex"),
	fileCount: files.length,
	dirty: Boolean(
		Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"])
			.stdout.toString()
			.trim(),
	),
};
const phase = process.env.LAB_PILOT_PHASE ?? "all";
const plans = [
	{ request: "TypeScriptのunknown型を日本語で説明して", browser: false },
	{
		request:
			"Explain the meaning of unknown in plain English without looking anything up.",
		browser: false,
	},
	{
		request: "https://example.org/ を開いて、題名を教えてください。",
		browser: true,
	},
	{
		request: "『価格120円、在庫3個』という結果だけを1文にまとめて",
		browser: false,
	},
];
const at = new Date().toISOString();
const output = `docs/reviews/2026-11-05/implementation/api-pilot-${at.replaceAll(":", "-")}.json`;
mkdirSync("lab/data", { recursive: true });
const db = openLabDb("lab/data/api-pilot.sqlite");
const server = startFixtureServer();
ensureClaudeCredential();
const rows: unknown[] = [];
const blockedProviders = new Set<string>();
const meta = (out: InferenceOutcome) => ({
	kind: out.kind,
	...(out.kind === "text" ? {} : { code: out.code }),
	usage: out.usage,
	latencyMs: out.latencyMs,
	metadata: out.metadata ?? null,
});
const save = () => {
	const ledger = paidLedger();
	writeFileSync(
		output,
		JSON.stringify(
			{
				at,
				scope: evaluationSplit
					? `author-run ${evaluationSplit} measurement, one repetition; not independent acceptance or a noninferiority study`
					: "author-run development pilot, not holdout or independent acceptance",
				snapshot,
				cases: IDS,
				conditions: {
					repetitions: 1,
					browser: "chrome",
					headless: true,
					effort: "low",
					maxOutputTokens: 2048,
					httpRetries: 0,
				},
				rows,
				budget: ledger.summary(),
			},
			null,
			2,
		) + "\n",
	);
	ledger.close();
};
const experiments = new Map<string, string>();
for (const p of ["claude", "openai"] as const) {
	const id = randomUUID();
	experiments.set(p, id);
	createExperiment(db, {
		id,
		name: `api-pilot-${p}`,
		caseIds: IDS,
		caseDigest: createHash("sha256")
			.update(JSON.stringify(cases.filter((c) => IDS.includes(c.id))))
			.digest("hex"),
		includesHoldout: evaluationSplit === "holdout",
		repetitions: 1,
		arms: ["arm1"],
		budget: {
			combinedUsd: 10,
			maxHttpAttempts: 500,
			maxOutputTokens: 2048,
			retries: 0,
		},
		inferenceKind: p,
		nowIso: at,
	});
}
try {
	for (const [index, id] of (phase === "plans" ? [] : IDS).entries()) {
		const def = cases.find((c) => c.id === id)!;
		for (const p of (index % 2
			? ["openai", "claude"]
			: ["claude", "openai"]) as ("claude" | "openai")[]) {
			if (blockedProviders.has(p)) continue;
			const inference =
				p === "claude"
					? startClaude(
							{ model: "claude-haiku-5-5", effort: "low" },
							silentLabLogger,
							id,
						)
					: startLuna();
			const browser = await createSession(
				{ headed: false, browser: "chrome" },
				silentLabLogger,
			);
			const calls: unknown[] = [];
			try {
				const port = asCollabAgent({
					complete: async (r) => {
						const out = await inference.raw.complete(r);
						calls.push({
							...meta(out),
							syntheticOutput: out.kind === "text" ? out.text : null,
						});
						if (out.kind === "error") blockedProviders.add(p);
						return out;
					},
				});
				const result = await runTrial({
					db,
					def,
					arm: "arm1",
					experimentId: experiments.get(p)!,
					repetition: 1,
					orderIndex: index,
					adapter: browser.adapter,
					inference: port,
					inferenceInfo: inference.info,
					approver: new FixtureApprover(def.approvalScript),
					logger: silentLabLogger,
					versions: collectVersions({
						browser: {
							channel: "chrome",
							customExecutable: false,
							headless: true,
						},
					}),
					fixtureBaseUrl: server.baseUrl,
				});
				rows.push({
					provider: p,
					case: id,
					runId: result.runId,
					status: result.status,
					code: result.code,
					success: result.score.success,
					score: result.score,
					transcript: result.transcript,
					calls,
				});
				console.log(
					`${p}\t${id}\t${result.status}\t${result.score.success ? "pass" : "FAIL"}`,
				);
			} finally {
				await browser.dispose();
				await inference.dispose();
				save();
			}
		}
	}
	for (const fixture of phase === "browser" ? [] : plans) {
		for (const p of ["claude", "openai"] as const) {
			const inference =
				p === "claude"
					? startClaude(
							{ model: "claude-haiku-5-5", effort: "low" },
							silentLabLogger,
							"plan-pilot",
						)
					: startLuna();
			const calls: unknown[] = [];
			try {
				const plan = await chainPlan(
					fixture.request,
					{
						complete: async (r) => {
							const out = await inference.raw.complete(r);
							calls.push({
								...meta(out),
								syntheticOutput: out.kind === "text" ? out.text : null,
							});
							return out;
						},
					},
					AbortSignal.timeout(90_000),
				);
				const browser = plan.steps.some(
					(s) => s.browser.by === "plan" && s.browser.browser,
				);
				rows.push({
					provider: p,
					type: "plan",
					request: fixture.request,
					expectedBrowser: fixture.browser,
					passed: browser === fixture.browser,
					plan,
					calls,
				});
				console.log(
					`${p}\tplan\t${browser === fixture.browser ? "pass" : "FAIL"}`,
				);
			} catch (e) {
				rows.push({
					provider: p,
					type: "plan",
					request: fixture.request,
					passed: false,
					error: e instanceof Error ? e.name : "unknown",
					calls,
				});
				console.log(`${p}\tplan\tFAIL`);
			} finally {
				await inference.dispose();
				save();
			}
		}
	}
} finally {
	save();
	db.close();
	server.stop();
}
console.log(output);

if (
	rows.some((r) => {
		const row = r as { success?: boolean; passed?: boolean };
		return row.success === false || row.passed === false;
	})
)
	process.exitCode = 1;
