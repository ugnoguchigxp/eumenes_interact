import { describe, expect, test } from "bun:test";
import type { InferencePort } from "eumenes-interact";
import { runScripted } from "./harness.ts";

/** Answers in order, one per call. */
const sequence = (texts: string[]): InferencePort => {
	let i = 0;
	return {
		complete: () =>
			Promise.resolve({
				kind: "text",
				text: texts[Math.min(i++, texts.length - 1)]!,
				usage: { inputTokens: 1, outputTokens: 1 },
				latencyMs: 1,
			}),
	};
};

describe("a done that cites only failed results", () => {
	test("ends failed with goal_unmet and keeps the answer as the reason", async () => {
		const { result } = await runScripted("dev-clarify-form", {
			inference: sequence([
				JSON.stringify({
					part: "page.find",
					args: { text: "存在しない項目zzzz", role: null },
				}),
				JSON.stringify({
					part: "done",
					args: { answer: "見つかりませんでした。", evidence: ["r1"] },
				}),
			]),
		});
		expect(result.status).toBe("failed");
		expect(result.code).toMatch(/^goal_unmet\./);
		expect(result.finalText).toBe("見つかりませんでした。");
	});

	test("a done with no evidence, or citing a completed result, still completes", async () => {
		const { result } = await runScripted("dev-clarify-form", {
			inference: sequence([
				JSON.stringify({
					part: "done",
					args: { answer: "済み", evidence: [] },
				}),
			]),
		});
		expect(result.status).toBe("completed");
	});
});
