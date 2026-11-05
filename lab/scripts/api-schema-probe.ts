import { writeFileSync } from "node:fs";
import { startRun, prepareStep, parseStep } from "eumenes-interact";
import {
	startClaude,
	startLuna,
	ensureClaudeCredential,
	paidLedger,
} from "../host/claude.ts";
import { silentLabLogger } from "../host/log.ts";
ensureClaudeCredential();
const rows = [];
for (const p of ["claude", "openai"] as const) {
	const session =
		p === "claude"
			? startClaude(
					{ model: "claude-haiku-5-5", effort: "low", maxTokens: 1024 },
					silentLabLogger,
					"wire-probe",
				)
			: startLuna();
	try {
		const state = startRun({
			arm: "arm1",
			request: "ブラウザ操作不要です。返答だけで「接続確認」と答えてください。",
			policy: { maxModelCalls: 2, retries: { default: 0 } },
			nowMs: Date.now(),
		});
		const out = await session.port.complete({
			...prepareStep(state),
			maxOutputTokens: 1024,
			signal: AbortSignal.timeout(60_000),
		});
		const step = out.kind === "text" ? parseStep(state, out.text).step : null;
		rows.push({
			provider: p,
			outcome: out,
			step,
			passed: step?.kind === "finish",
		});
		console.log(
			p,
			out.kind,
			step?.kind ?? (out.kind === "text" ? "invalid" : out.code),
		);
		if (out.kind !== "text") break; // Never repeat a rejected request shape across cases.
	} finally {
		await session.dispose();
	}
}
const ledger = paidLedger();
const report = { at: new Date().toISOString(), rows, budget: ledger.summary() };
ledger.close();
writeFileSync(
	`docs/reviews/2026-11-05/implementation/api-schema-probe-${Date.now()}.json`,
	JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report.budget));

if (rows.length !== 2 || rows.some((r) => !r.passed)) process.exitCode = 1;
