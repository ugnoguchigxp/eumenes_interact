import type { ChatMessage } from "./core.ts";

/**
 * The host's inference port (plan.md §4, §13.1). Provider formats stay in the host; the core only sees
 * the text. Implemented by the lab host (LARM) and by Eumenes' existing inference connection.
 */

export type InferenceRequest = {
	messages: ChatMessage[];
	maxOutputTokens: number;
	signal: AbortSignal;
};

export type InferenceUsage = {
	/** null when the provider did not report it (never 0 for unknown). */
	inputTokens: number | null;
	outputTokens: number | null;
	/** Prompt-cache reads and writes, when the provider reports them; otherwise absent or null. */
	cacheReadInputTokens?: number | null;
	cacheCreationInputTokens?: number | null;
};

/** Classified per call (plan.md §11 "出力の不正"). */
export type InferenceOutcome =
	| { kind: "text"; text: string; usage: InferenceUsage; latencyMs: number }
	| {
			kind: "refused" | "empty" | "malformed" | "error";
			code: string;
			usage: InferenceUsage;
			latencyMs: number;
	  };

export interface InferencePort {
	complete(request: InferenceRequest): Promise<InferenceOutcome>;
}
