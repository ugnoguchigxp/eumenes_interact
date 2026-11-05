/** Paid falsification of the semantic reviewer using preserved false completions, with no browser actions. */
import { readFileSync, writeFileSync } from "node:fs";
import type { ChatMessage } from "eumenes-interact";
import { getRun } from "eumenes-interact/sqlite";
import { openLabDb } from "../host/db.ts";
import { LAB_OWNER } from "../host/run.ts";
import {
	completionRequest,
	parseCompletionReview,
} from "../host/completion.ts";
import {
	startClaude,
	startLuna,
	lunaSettings,
	ensureClaudeCredential,
	paidLedger,
} from "../host/claude.ts";
import { silentLabLogger } from "../host/log.ts";
import { loadCases } from "../cases/load.ts";
const rows: unknown[] = [];
const db = openLabDb("lab/data/api-pilot.sqlite");
const custom = JSON.parse(
	readFileSync("lab/evaluation/independent-browser-cases.json", "utf8"),
);
const cases = [
	...(await loadCases({ includeHoldout: false })),
	...(Array.isArray(custom) ? custom : custom.cases),
] as { id: string; request: string }[];
ensureClaudeCredential();
const effort = process.env.LAB_REVIEW_EFFORT === "medium" ? "medium" : "low";
try {
	for (const report of [
		"api-pilot-2026-11-05T11-28-06.443Z.json",
		"api-pilot-2026-11-05T12-34-28.247Z.json",
	]) {
		const old = JSON.parse(
			readFileSync(`docs/reviews/2026-11-05/implementation/${report}`, "utf8"),
		);
		const failed = old.rows.find(
			(r: { score?: { falseFinish: boolean } }) => r.score?.falseFinish,
		);
		if (!failed) throw new Error("replay_case_missing");
		const state = getRun(db, LAB_OWNER, failed.runId)?.coreState as {
			messages: ChatMessage[];
		} | null;
		if (!state?.messages) throw new Error("replay_state_missing");
		const done = JSON.parse(failed.calls.at(-1).syntheticOutput);
		const request = cases.find((c) => c.id === failed.case)!.request;
		for (const provider of ["claude", "openai"] as const) {
			const session =
				provider === "claude"
					? startClaude(
							{ model: "claude-haiku-5-5", effort },
							silentLabLogger,
							"completion-replay",
						)
					: startLuna(lunaSettings({ effort }));
			try {
				const out = await session.raw.complete(
					completionRequest(
						{
							originalRequest: request,
							task: request,
							answer: done.text,
							evidence: done.arguments.evidence,
							trace: state.messages,
						},
						AbortSignal.timeout(90_000),
					),
				);
				if (out.kind !== "text") throw new Error(`replay_api_${out.kind}`);
				const verdict = parseCompletionReview(out.text);
				const passed = verdict.outcome !== "achieved";
				rows.push({
					provider,
					effort,
					report,
					case: failed.case,
					passed,
					verdict,
					usage: out.usage,
					metadata: out.metadata,
				});
				console.log(`${provider}\t${failed.case}\t${passed ? "pass" : "FAIL"}`);
			} finally {
				await session.dispose();
			}
		}
	}
} finally {
	const ledger = paidLedger();
	const path = `docs/reviews/2026-11-05/implementation/api-completion-replay-${Date.now()}.json`;
	writeFileSync(
		path,
		JSON.stringify(
			{
				at: new Date().toISOString(),
				scope:
					"Replay of two preserved false completions; judges must reject; no external actions",
				rows,
				budget: ledger.summary(),
			},
			null,
			2,
		) + "\n",
	);
	ledger.close();
	db.close();
	console.log(path);
}
if (rows.some((r) => (r as { passed: boolean }).passed === false))
	process.exitCode = 1;
