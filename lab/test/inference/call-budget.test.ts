import { expect, test } from "bun:test";
import { CallBudget } from "../../inference/call-budget.ts";
import type { InferencePort } from "eumenes-interact";
test("planning, choices, reruns and summaries consume the same total and step allowances", async () => {
	let sent = 0;
	const inner: InferencePort = {
		complete: async () => {
			sent++;
			return {
				kind: "error",
				code: "http_429",
				usage: { inputTokens: null, outputTokens: null },
				latencyMs: 1,
			};
		},
	};
	const b = new CallBudget(4);
	const request = {
		messages: [],
		maxOutputTokens: 10,
		signal: new AbortController().signal,
	};
	await b.port(inner, "plan", 1).complete(request);
	await b.port(inner, "s1", 2).complete(request);
	await b.port(inner, "s1", 2).complete(request);
	await expect(b.port(inner, "s1", 2).complete(request)).rejects.toThrow(
		"inference_budget_exhausted",
	);
	await b.port(inner, "summary", 2).complete(request);
	await expect(b.port(inner, "s2", 2).complete(request)).rejects.toThrow(
		"inference_budget_exhausted",
	);
	expect(sent).toBe(4);
	expect(b.used).toBe(4);
});
