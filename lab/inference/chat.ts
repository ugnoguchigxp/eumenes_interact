import type { ChatMessage, InferenceUsage } from "eumenes-interact";
import type { Provider } from "./connection.ts";
import { LarmError, readBounded } from "./guards.ts";

/**
 * The most a response may carry, and the longest answer text (Eumenes `chat-stream.ts`). An output that
 * runs long ends at its token limit (finish reason `length`), not as an oversized body.
 */
const RESPONSE_BYTES_LIMIT = 4_000_000;
const TEXT_CHARS_LIMIT = 65_536;

/**
 * A legacy claim caps output at its reserve; `remaining-context` takes the request's own bound
 * (Eumenes `sentMaxTokens`).
 */
function sentMaxTokens(window: Provider["contextWindow"], requested: number) {
	return window.outputLimit === "remaining-context"
		? requested
		: Math.min(window.outputReserveTokens, requested);
}

/**
 * The body of a plain, non-streaming chat (Eumenes `chatRequest` with no tools, no JSON output and no
 * reasoning option). No `response_format`: Arm 0 sends no output-schema control.
 */
export function chatBody(
	provider: Provider,
	messages: ChatMessage[],
	maxOutputTokens: number,
	promptCacheKey: string,
) {
	return {
		model: provider.model,
		prompt_cache_key: promptCacheKey,
		messages: messages.map(({ role, content }) => ({ role, content })),
		stream: false,
		max_tokens: sentMaxTokens(provider.contextWindow, maxOutputTokens),
	};
}

export type Classified =
	| { kind: "text"; text: string; usage: InferenceUsage }
	| {
			kind: "refused" | "empty" | "malformed";
			code: string;
			usage: InferenceUsage;
	  };

const noUsage: InferenceUsage = { inputTokens: null, outputTokens: null };

/** Never 0 for unknown: a counter the provider did not report stays null. */
function usageOf(value: unknown): InferenceUsage {
	if (!value || typeof value !== "object") return noUsage;
	const { prompt_tokens: input, completion_tokens: output } = value as Record<
		string,
		unknown
	>;
	const count = (n: unknown) =>
		typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
	return { inputTokens: count(input), outputTokens: count(output) };
}

/**
 * Reads and classifies one chat response (Eumenes `readChatResponse`, non-streaming). Read failures
 * (transport, abort) throw; everything the provider did say is classified, never thrown.
 */
export async function readChat(
	response: Response,
	signal: AbortSignal,
): Promise<Classified> {
	let payload: unknown;
	try {
		const bytes = await readBounded(
			response.body,
			RESPONSE_BYTES_LIMIT,
			"response_too_large",
			signal,
		);
		payload = JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		if (signal.aborted) throw error;
		if (error instanceof LarmError)
			return {
				kind: "malformed",
				code:
					error.code === "response_too_large" ? error.code : "empty_response",
				usage: noUsage,
			};
		if (error instanceof SyntaxError)
			return { kind: "malformed", code: "invalid_json", usage: noUsage };
		throw error;
	}
	const body =
		payload && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: undefined;
	if (!body)
		return { kind: "malformed", code: "invalid_response", usage: noUsage };
	const usage = usageOf(body.usage);
	if (body.error)
		return { kind: "malformed", code: "provider_error_field", usage };
	const choice = (Array.isArray(body.choices) ? body.choices : []).find(
		(c): c is Record<string, unknown> =>
			!!c &&
			typeof c === "object" &&
			((c as { index?: unknown }).index === 0 ||
				(c as { index?: unknown }).index === undefined),
	);
	if (!choice) return { kind: "malformed", code: "no_choice", usage };
	const message =
		choice.message && typeof choice.message === "object"
			? (choice.message as Record<string, unknown>)
			: undefined;
	if (!message) return { kind: "malformed", code: "no_message", usage };
	if (typeof message.refusal === "string" && message.refusal)
		return { kind: "refused", code: "refusal", usage };
	if (choice.finish_reason === "content_filter")
		return { kind: "refused", code: "content_filter", usage };
	// Output cut at its token limit is not a complete answer (Eumenes: chat_stream_incomplete).
	if (choice.finish_reason === "length")
		return { kind: "malformed", code: "output_limit", usage };
	const content = message.content;
	if (content != null && typeof content !== "string")
		return { kind: "malformed", code: "invalid_content", usage };
	if (!content?.trim()) return { kind: "empty", code: "empty_output", usage };
	if (content.length > TEXT_CHARS_LIMIT)
		return { kind: "malformed", code: "output_too_large", usage };
	return { kind: "text", text: content, usage };
}

/** Bounded diagnostic of a refused request: only the provider's machine-readable error code. */
export async function providerErrorCode(
	response: Response,
	signal: AbortSignal,
): Promise<string | undefined> {
	try {
		const bytes = await readBounded(
			response.body,
			16_384,
			"provider_error_too_large",
			AbortSignal.any([signal, AbortSignal.timeout(3000)]),
		);
		const code = JSON.parse(new TextDecoder().decode(bytes))?.error?.code;
		return typeof code === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(code)
			? code
			: undefined;
	} catch {
		return undefined;
	}
}
