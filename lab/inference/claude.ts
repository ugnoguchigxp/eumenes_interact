import Anthropic from "@anthropic-ai/sdk";
import type {
	ChatMessage,
	InferenceOutcome,
	InferencePort,
	InferenceUsage,
	LoggerPort,
} from "eumenes-interact";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudeSettings = {
	model: string;
	effort: ClaudeEffort;
	/** Overrides the output bound; see `outputBound`. */
	maxTokens?: number;
};

/** The model the Claude measurement runs on: no date suffix, effort always sent explicitly. */
export const DEFAULT_CLAUDE_SETTINGS: ClaudeSettings = {
	model: "claude-haiku-5-5",
	effort: "low",
};

/**
 * Thinking tokens count against `max_tokens` (adaptive thinking is on by default), so Arm 0's small
 * per-call budget would cut the answer short. This is a deliberate deviation from the LARM path, where
 * `maxOutputTokens` is sent as is. Non-streaming, so it stays below the SDK's long-request limit.
 */
const outputBound = (settings: ClaudeSettings, requested: number) =>
	settings.maxTokens ?? Math.max(requested, 16_000);

/**
 * Arm 0's list starts with the system message: that goes to the top-level `system`, the rest are the
 * conversation. No assistant prefill (rejected by current models).
 */
function split(messages: ChatMessage[]) {
	const system = messages
		.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n\n");
	return {
		system,
		turns: messages.flatMap((m) =>
			m.role === "system"
				? []
				: [{ role: m.role, content: m.content } as const],
		),
	};
}

const count = (n: number | null | undefined) =>
	typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;

/**
 * Anthropic reports `input_tokens` as the uncached part of the prompt; cache reads and writes are
 * separate counters. A counter the API did not report stays null, never 0.
 */
function usageOf(usage: Anthropic.Messages.Usage | undefined): InferenceUsage {
	return {
		inputTokens: count(usage?.input_tokens),
		outputTokens: count(usage?.output_tokens),
		cacheReadInputTokens: count(usage?.cache_read_input_tokens),
		cacheCreationInputTokens: count(usage?.cache_creation_input_tokens),
	};
}

type Classified =
	| { kind: "text"; text: string }
	| { kind: "refused" | "empty" | "malformed"; code: string };

/**
 * `end_turn` is a finished answer. A refusal is `refused` (with the category when the API names one).
 * A cut answer (`max_tokens`, `model_context_window_exceeded`) and anything else that is not a finished
 * turn (`pause_turn`, `stop_sequence`, `tool_use`; none is requested here, so none can be complete) is
 * `malformed` under its own stop reason.
 */
function classify(message: Anthropic.Messages.Message): Classified {
	switch (message.stop_reason) {
		case "refusal": {
			const category = message.stop_details?.category;
			return {
				kind: "refused",
				code: category ? `refusal:${category}` : "refusal",
			};
		}
		case "max_tokens":
			return { kind: "malformed", code: "output_limit" };
		case "end_turn":
		case null:
			break;
		default:
			return { kind: "malformed", code: message.stop_reason };
	}
	// Thinking blocks may be present (their text can be empty): only the text blocks are the answer.
	const text = message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");
	return text.trim()
		? { kind: "text", text }
		: { kind: "empty", code: "empty_output" };
}

/** Typed classes, most specific first; never message matching. */
function errorCode(error: unknown, signal: AbortSignal): string {
	if (signal.aborted) {
		const reason: unknown = signal.reason;
		return reason instanceof DOMException && reason.name === "TimeoutError"
			? "deadline"
			: "aborted";
	}
	if (error instanceof Anthropic.APIUserAbortError) return "aborted";
	if (error instanceof Anthropic.APIConnectionTimeoutError) return "deadline";
	if (error instanceof Anthropic.APIConnectionError) return "transport_lost";
	if (error instanceof Anthropic.AuthenticationError) return "http_401";
	if (error instanceof Anthropic.RateLimitError) return "http_429";
	if (error instanceof Anthropic.BadRequestError) return "http_400";
	if (error instanceof Anthropic.APIError)
		return `http_${error.status ?? "unknown"}`;
	return "claude_failed";
}

/**
 * The host's inference port over the Claude API (plan.md §4). The SDK resolves the key itself
 * (`ANTHROPIC_API_KEY`, which Bun loads from `.env`); this module never reads, logs or stores it, and
 * errors are reduced to fixed codes. The SDK's own retries (408/409/429/5xx, twice) stay on: inference
 * has no side effect, so a resend cannot do harm.
 */
export function createClaudeInference(o: {
	settings: ClaudeSettings;
	logger: LoggerPort;
	correlationId: string;
	client?: Pick<Anthropic, "messages">;
}): InferencePort & {
	describe(): { provider: "anthropic"; model: string; effort: ClaudeEffort };
} {
	const { settings } = o;
	const client = o.client ?? new Anthropic();
	const emit = (
		name: "inference.completed" | "inference.failed",
		fields: { code: string; durationMs: number },
	) => {
		try {
			o.logger.event(name, { correlationId: o.correlationId, ...fields });
		} catch {
			// Diagnostics must never change the inference result.
		}
	};
	return {
		async complete(request): Promise<InferenceOutcome> {
			const started = performance.now();
			const finish = (outcome: InferenceOutcome) => {
				emit(
					outcome.kind === "text" ? "inference.completed" : "inference.failed",
					{
						code: outcome.kind === "text" ? "text" : outcome.code,
						durationMs: outcome.latencyMs,
					},
				);
				return outcome;
			};
			const latencyMs = () => Math.round(performance.now() - started);
			const { system, turns } = split(request.messages);
			try {
				request.signal.throwIfAborted();
				const message = await client.messages.create(
					{
						model: settings.model,
						max_tokens: outputBound(settings, request.maxOutputTokens),
						...(system ? { system } : {}),
						messages: turns,
						// Haiku 5.5 defaults to medium: the effort is always sent.
						output_config: { effort: settings.effort },
						// Arm 0 requests are append-only: each step reads the previous prefix from cache.
						cache_control: { type: "ephemeral" },
					},
					{ signal: request.signal },
				);
				const result = classify(message);
				return finish({
					...result,
					usage: usageOf(message.usage),
					latencyMs: latencyMs(),
				});
			} catch (error) {
				return finish({
					kind: "error",
					code: errorCode(error, request.signal),
					usage: usageOf(undefined),
					latencyMs: latencyMs(),
				});
			}
		},
		describe: () => ({
			provider: "anthropic",
			model: settings.model,
			effort: settings.effort,
		}),
	};
}

/**
 * Estimated list prices in USD per million tokens, from the Claude API pricing reference as of
 * 2026-11-03. An estimate for comparing arms, not a bill: verify against the pricing page.
 * A prompt above `longAbove` tokens is billed at the `long` rates.
 */
const PRICES: Record<
	string,
	{
		input: number;
		output: number;
		long: { input: number; output: number };
		longAbove: number;
	}
> = {
	"claude-haiku-5-5": {
		input: 0.1,
		output: 0.5,
		long: { input: 0.5, output: 2.5 },
		longAbove: 100_000,
	},
};
/** Standard prompt-cache multipliers of the input price (5-minute TTL). An assumption to verify. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Null for an unknown model or when input/output tokens are unknown. Unreported cache counters count
 * as no cache use.
 */
export function estimateClaudeCostUsd(
	model: string,
	usage: InferenceUsage,
): number | null {
	const price = PRICES[model];
	if (!price || usage.inputTokens === null || usage.outputTokens === null)
		return null;
	const read = usage.cacheReadInputTokens ?? 0;
	const write = usage.cacheCreationInputTokens ?? 0;
	const rates =
		usage.inputTokens + read + write > price.longAbove ? price.long : price;
	return (
		(usage.inputTokens * rates.input +
			read * rates.input * CACHE_READ_MULTIPLIER +
			write * rates.input * CACHE_WRITE_MULTIPLIER +
			usage.outputTokens * rates.output) /
		1_000_000
	);
}
