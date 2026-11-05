/** Explicitly invoked, paid connectivity probe. Uses the same durable $10 ledger as subsequent evals. */
import { writeFileSync, mkdirSync } from "node:fs";
import {
	startClaude,
	startLuna,
	ensureClaudeCredential,
	paidLedger,
} from "../host/claude.ts";
import { silentLabLogger } from "../host/log.ts";
const rows = [];
ensureClaudeCredential();
for (const provider of ["claude", "openai"] as const) {
	const session =
		provider === "claude"
			? startClaude(
					{ model: "claude-haiku-5-5", effort: "low", maxTokens: 1024 },
					silentLabLogger,
					"connectivity",
				)
			: startLuna();
	try {
		const out = await session.raw.complete({
			messages: [
				{ role: "user", content: 'Return the JSON object {"value":7}.' },
			],
			maxOutputTokens: 1024,
			outputSchema: {
				type: "object",
				properties: { value: { type: "integer" } },
				required: ["value"],
				additionalProperties: false,
			},
			signal: AbortSignal.timeout(60_000),
		});
		let passed = false;
		try {
			passed = out.kind === "text" && JSON.parse(out.text).value === 7;
		} catch {
			/* recorded below */
		}
		rows.push({
			provider,
			requested: session.info(),
			passed,
			kind: out.kind,
			code: out.kind === "text" ? null : out.code,
			usage: out.usage,
			latencyMs: out.latencyMs,
		});
	} finally {
		await session.dispose();
	}
}
const ledger = paidLedger();
const report = { at: new Date().toISOString(), rows, budget: ledger.summary() };
ledger.close();
mkdirSync("docs/reviews/2026-11-05/implementation", { recursive: true });
writeFileSync(
	"docs/reviews/2026-11-05/implementation/api-smoke.json",
	JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
if (rows.some((r) => !r.passed)) process.exitCode = 1;
