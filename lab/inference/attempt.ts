import type { InferenceMetadata } from "eumenes-interact";

/** What the caller asked for: known before anything is sent. */
export type RequestedCall = {
	provider: string;
	model: string;
	effort?: string;
};

/** What a provider response actually said. Anything not a string is unknown, never guessed. */
export type ObservedResponse = {
	model?: unknown;
	id?: unknown;
	serviceTier?: unknown;
};

const text = (value: unknown): string | null =>
	typeof value === "string" && value ? value : null;

/**
 * The one place per-call provider metadata is built, for every outcome (text, refused, empty,
 * malformed and error). The requested provider, model and effort are always recorded;
 * `httpAttempts` is the number of HTTP requests actually dispatched (0 when the call ended before
 * sending); the returned model, response id and service tier come only from a response that was
 * read, and stay `null` otherwise (a failure never invents a returned model).
 */
export function attemptMetadata(
	requested: RequestedCall,
	httpAttempts: number,
	observed: ObservedResponse = {},
): InferenceMetadata {
	return {
		provider: requested.provider,
		requestedModel: requested.model,
		...(requested.effort === undefined
			? {}
			: { requestedEffort: requested.effort }),
		returnedModel: text(observed.model),
		responseId: text(observed.id),
		serviceTier: text(observed.serviceTier),
		httpAttempts,
	};
}
