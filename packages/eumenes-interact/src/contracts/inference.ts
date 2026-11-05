import type { ChatMessage } from "./core.ts";

/**
 * The host's inference port (plan.md §4, §13.1). Provider formats stay in the host; the core only sees
 * the text. Implemented by the lab host (LARM) and by Eumenes' existing inference connection.
 */

export type InferenceRequest = {
	messages: ChatMessage[];
	maxOutputTokens: number;
	signal: AbortSignal;
	/**
	 * JSON Schema the output must follow (from `PreparedStep.outputSchema`). A port that cannot enforce it
	 * must say so (`error` with code `output_schema_unsupported`), never ignore it silently.
	 */
	outputSchema?: Record<string, unknown>;
};

export type InferenceUsage = {
	/** null when the provider did not report it (never 0 for unknown). */
	inputTokens: number | null;
	outputTokens: number | null;
	/** Prompt-cache reads and writes, when the provider reports them; otherwise absent or null. */
	cacheReadInputTokens?: number | null;
	cacheCreationInputTokens?: number | null;
	reasoningTokens?: number | null;
};

/** Public provider identifiers only. Never contains a request body, credentials or raw errors. */
export type InferenceMetadata = {
	provider: string;
	requestedModel: string;
	returnedModel: string | null;
	responseId: string | null;
	serviceTier: string | null;
	httpAttempts: number;
	requestedEffort?: string;
};

/** Classified per call (plan.md §11 "出力の不正"). */
export type InferenceOutcome =
	| {
			kind: "text";
			text: string;
			usage: InferenceUsage;
			latencyMs: number;
			metadata?: InferenceMetadata;
	  }
	| {
			kind: "refused" | "empty" | "malformed" | "error";
			code: string;
			usage: InferenceUsage;
			latencyMs: number;
			metadata?: InferenceMetadata;
	  };

export interface InferencePort {
	/** Identity of the frozen skill body this trusted adapter actually applies (not provider credentials). */
	readonly skill?: { ref: string; digest: string };
	/** Trusted host policy: a fresh-context semantic review using the same bounded inference budget. */
	readonly completionVerifiers?: readonly Pick<InferencePort, "complete">[];
	complete(request: InferenceRequest): Promise<InferenceOutcome>;
}
