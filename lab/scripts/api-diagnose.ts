/** One bounded diagnostic request; raw provider errors never reach product logs or reports. */
import Anthropic from "@anthropic-ai/sdk";
import { createClaudeInference } from "../inference/claude.ts";
import { budgetedInference } from "../inference/spend.ts";
import { paidLedger, ensureClaudeCredential } from "../host/claude.ts";
import { asCollabAgent } from "../host/collab.ts";
import { startRun, prepareStep } from "eumenes-interact";
import { silentLabLogger } from "../host/log.ts";
import { writeFileSync } from "node:fs";
ensureClaudeCredential();
const secrets = Object.entries(process.env)
	.filter(([k, v]) => /KEY|TOKEN|SECRET/.test(k) && v && v.length > 3)
	.map(([, v]) => v!);
const redact = (s: string) => {
	for (const secret of secrets) s = s.split(secret).join("[redacted]");
	return s.replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]").slice(0, 2000);
};
const real = new Anthropic({
	apiKey: process.env.ANTHROPIC_API_KEY,
	maxRetries: 0,
	baseURL: "https://api.anthropic.com",
	fetchOptions: { redirect: "error" },
});
let diagnostic: { type: string; message: string } | null = null;
const client = {
	messages: {
		create: async (...args: Parameters<typeof real.messages.create>) => {
			try {
				return await real.messages.create(...args);
			} catch (e) {
				diagnostic = {
					type: e instanceof Error ? e.name : "unknown",
					message: redact(e instanceof Error ? e.message : "unknown"),
				};
				throw e;
			}
		},
	},
} as unknown as Pick<Anthropic, "messages">;
const ledger = paidLedger();
const raw = createClaudeInference({
	settings: { model: "claude-haiku-5-5", effort: "low", maxTokens: 1024 },
	logger: silentLabLogger,
	correlationId: "diagnostic",
	client,
});
try {
	const state = startRun({
		arm: "arm1",
		request: "ブラウザは使わず、返答だけで接続確認と答えてください。",
		policy: { maxModelCalls: 2, retries: { default: 0 } },
		nowMs: Date.now(),
	});
	const out = await asCollabAgent(
		budgetedInference(raw, ledger, "claude-haiku-5-5"),
	).complete({
		...prepareStep(state),
		maxOutputTokens: 1024,
		signal: AbortSignal.timeout(60_000),
	});
	const report = {
		at: new Date().toISOString(),
		diagnostic,
		kind: out.kind,
		budget: ledger.summary(),
	};
	writeFileSync(
		`docs/reviews/2026-11-05/implementation/api-diagnostic-${Date.now()}.json`,
		JSON.stringify(report, null, 2) + "\n",
	);
	console.log(JSON.stringify(report));
} finally {
	ledger.close();
}
