import type { InferencePort, InferenceUsage } from "eumenes-interact";
import type { Fetcher } from "./guards.ts";

export const LUNA_MODEL = "gpt-6-luna";
const count = (n: unknown) =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
const unknownUsage = (): InferenceUsage => ({
	inputTokens: null,
	outputTokens: null,
	cacheReadInputTokens: null,
	cacheCreationInputTokens: null,
});

/** Responses API, fixed origin, no redirects, no tools, no server storage and exactly one HTTP attempt. */
export function createOpenAIInference(
	o: {
		apiKey?: string;
		model?: string;
		effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
		maxTokens?: number;
		fetch?: Fetcher;
	} = {},
): InferencePort {
	const key =
		o.apiKey ?? (process.env.OPENAI_API_KEY || process.env.OPEN_AI_API_KEY);
	if (!key)
		throw new Error(
			"openai_credential_missing: export OPENAI_API_KEY or OPEN_AI_API_KEY in your login shell",
		);
	return {
		async complete(request) {
			const start = performance.now();
			const latencyMs = () => Math.round(performance.now() - start);
			try {
				request.signal.throwIfAborted();
				const response = await (o.fetch ?? fetch)(
					"https://api.openai.com/v1/responses",
					{
						method: "POST",
						redirect: "error",
						signal: request.signal,
						headers: {
							Authorization: `Bearer ${key}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							model: o.model ?? LUNA_MODEL,
							input: request.messages,
							max_output_tokens: Math.min(
								request.maxOutputTokens,
								o.maxTokens ?? request.maxOutputTokens,
							),
							reasoning: { effort: o.effort ?? "low" },
							store: false,
							service_tier: "default",
							...(request.outputSchema
								? {
										text: {
											format: {
												type: "json_schema",
												name: "interact",
												strict: true,
												schema: request.outputSchema,
											},
										},
									}
								: {}),
						}),
					},
				);
				if (!response.ok) {
					await response.body?.cancel();
					return {
						kind: "error",
						code: `http_${response.status}`,
						usage: unknownUsage(),
						latencyMs: latencyMs(),
					};
				}
				// A bounded stream prevents an invalid upstream response from consuming arbitrary memory.
				const reader = response.body?.getReader();
				if (!reader) throw new Error("empty_response");
				const decoder = new TextDecoder();
				let body = "";
				let bytes = 0;
				try {
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
						bytes += chunk.value.length;
						if (bytes > 4_000_000) throw new Error("response_too_large");
						body += decoder.decode(chunk.value, { stream: true });
					}
					body += decoder.decode();
				} finally {
					await reader.cancel().catch(() => {});
				}
				const data = JSON.parse(body);
				const totalInput = count(data.usage?.input_tokens);
				const cachedInput = count(
					data.usage?.input_tokens_details?.cached_tokens,
				);
				const usage: InferenceUsage = {
					inputTokens:
						totalInput !== null &&
						cachedInput !== null &&
						cachedInput <= totalInput
							? totalInput - cachedInput
							: null,
					outputTokens: count(data.usage?.output_tokens),
					cacheReadInputTokens: cachedInput,
					cacheCreationInputTokens: 0,
					reasoningTokens: count(
						data.usage?.output_tokens_details?.reasoning_tokens,
					),
				};
				if (data.status !== "completed")
					return {
						kind: "malformed",
						code:
							data.status === "incomplete" ? "output_limit" : "response_failed",
						usage,
						latencyMs: latencyMs(),
					};
				const content = (Array.isArray(data.output) ? data.output : []).flatMap(
					(item: { type?: string; content?: unknown[] }) =>
						item.type === "message" && Array.isArray(item.content)
							? item.content
							: [],
				) as { type?: string; text?: string }[];
				if (content.some((c) => c.type === "refusal"))
					return {
						kind: "refused",
						code: "refusal",
						usage,
						latencyMs: latencyMs(),
					};
				const text = content
					.filter((c) => c.type === "output_text" && typeof c.text === "string")
					.map((c) => c.text)
					.join("");
				return text.trim()
					? {
							kind: "text",
							text,
							usage,
							latencyMs: latencyMs(),
							metadata: {
								provider: "openai",
								requestedModel: o.model ?? LUNA_MODEL,
								requestedEffort: o.effort ?? "low",
								returnedModel:
									typeof data.model === "string" ? data.model : null,
								responseId: typeof data.id === "string" ? data.id : null,
								serviceTier:
									typeof data.service_tier === "string"
										? data.service_tier
										: null,
								httpAttempts: 1,
							},
						}
					: {
							kind: "empty",
							code: "empty_output",
							usage,
							latencyMs: latencyMs(),
						};
			} catch {
				return {
					kind: "error",
					code: request.signal.aborted
						? "aborted"
						: "openai_transport_or_contract",
					usage: unknownUsage(),
					latencyMs: latencyMs(),
				};
			}
		},
	};
}
