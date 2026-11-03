import type { ChatMessage, InferencePort } from "eumenes-interact";
import { latestObservation, latestTabs, resolveTarget } from "./resolve.ts";
import type { Script, ScriptStep, Target } from "./script.ts";

/**
 * A deterministic `InferencePort` for the fixed-response acceptance (plan.md §15 S1). It emits exactly the
 * Arm 0 output JSON a model would, so everything goes through the same `parseStep`. The step it is on is the
 * number of its own outputs already in the messages. A target it cannot find, or finds twice, becomes a
 * clarify: it never guesses.
 */

const clarify = (text: string) => JSON.stringify({ action: "clarify", text });

const targetText = (t: Target) =>
	`${t.role ?? t.roleAnyOf?.join("/")}「${t.name ?? t.nameAnyOf?.join("/") ?? t.urlIncludes ?? ""}」`;

function invoke(
	step: Extract<ScriptStep, { tool: string }>,
	messages: ChatMessage[],
) {
	const args: Record<string, unknown> = { ...step.args };
	if (step.target) {
		const seen = latestObservation(messages);
		if (!seen) return clarify("最新の観測が見つかりません。");
		const found = resolveTarget(seen.text, step.target);
		if (found.kind !== "found")
			return clarify(
				found.kind === "none"
					? `${targetText(step.target)}が見つかりません。`
					: `${targetText(step.target)}が複数あり、どれか決められません。`,
			);
		Object.assign(args, {
			observationRef: seen.observationRef,
			ref: found.ref,
			// The page's own name for it, as the model would copy it, cut to what the tool accepts.
			element: `${found.role} "${found.name ?? ""}"`.slice(0, 200),
		});
	}
	if (step.tab) {
		const title = step.tab.title;
		const hits = (latestTabs(messages) ?? []).filter((t) =>
			t.title.includes(title),
		);
		if (hits.length === 0) return clarify(`タブ「${title}」が見つかりません。`);
		if (hits.length > 1)
			return clarify(`タブ「${title}」が複数あり、どれか決められません。`);
		args.tabRef = hits[0]!.tabRef;
	}
	return JSON.stringify({ action: "invoke", tool: step.tool, arguments: args });
}

/** The output of the script's next step for the conversation so far. */
export function nextOutput(script: Script, messages: ChatMessage[]): string {
	const step =
		script.steps[messages.filter((m) => m.role === "assistant").length];
	if (!step) return clarify("手順を使い切りました。");
	if ("finish" in step)
		return JSON.stringify({ action: "finish", text: step.finish });
	if ("clarify" in step) return clarify(step.clarify);
	return invoke(step, messages);
}

export function createScriptedInference(script: Script): InferencePort {
	return {
		complete: ({ messages }) =>
			Promise.resolve({
				kind: "text",
				text: nextOutput(script, messages),
				// A script reports no usage: unknown, never 0.
				usage: { inputTokens: null, outputTokens: null },
				latencyMs: 0,
			}),
	};
}
