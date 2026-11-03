import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, InferenceUsage } from "eumenes-interact";
import {
	DEFAULT_CLAUDE_SETTINGS,
	createClaudeInference,
	estimateClaudeCostUsd,
	type ClaudeSettings,
} from "../../inference/index.ts";
import { recordingLogger } from "./fake-larm.ts";

const KEY = "sk-ant-secret-key-0123";

const messages: ChatMessage[] = [
	{ role: "system", content: "rules" },
	{ role: "user", content: "observe 1" },
	{ role: "assistant", content: '{"a":1}' },
	{ role: "user", content: "observe 2" },
];

type Params = Record<string, unknown>;
type Reply = (
	params: Params,
	options: { signal?: AbortSignal },
) => unknown | Promise<unknown>;

const message = (overrides: Params = {}) => ({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-haiku-5-5",
	content: [{ type: "text", text: '{"ok":true}' }],
	stop_reason: "end_turn",
	stop_details: null,
	stop_sequence: null,
	usage: {
		input_tokens: 120,
		output_tokens: 30,
		cache_creation_input_tokens: 50,
		cache_read_input_tokens: 400,
	},
	...overrides,
});

function setup(reply: Reply = () => message(), settings?: ClaudeSettings) {
	const requests: { params: Params; options: { signal?: AbortSignal } }[] = [];
	const client = {
		messages: {
			create: async (params: Params, options: { signal?: AbortSignal }) => {
				requests.push({ params, options });
				return reply(params, options);
			},
		},
	} as unknown as Pick<Anthropic, "messages">;
	const log = recordingLogger();
	const port = createClaudeInference({
		settings: settings ?? DEFAULT_CLAUDE_SETTINGS,
		logger: log.logger,
		correlationId: "corr-1",
		client,
	});
	const complete = (
		overrides: { maxOutputTokens?: number; signal?: AbortSignal } = {},
	) =>
		port.complete({
			messages,
			maxOutputTokens: 1024,
			signal: new AbortController().signal,
			...overrides,
		});
	return { port, complete, requests, ...log };
}

describe("request", () => {
	test("sends model, effort, system split, cache control and nothing sampled", async () => {
		const { complete, requests } = setup();
		await complete();
		const { params, options } = requests[0]!;
		expect(params).toEqual({
			model: "claude-haiku-5-5",
			max_tokens: 16_000,
			system: "rules",
			messages: [
				{ role: "user", content: "observe 1" },
				{ role: "assistant", content: '{"a":1}' },
				{ role: "user", content: "observe 2" },
			],
			output_config: { effort: "low" },
			cache_control: { type: "ephemeral" },
		});
		for (const field of [
			"temperature",
			"top_p",
			"top_k",
			"thinking",
			"stream",
			"tools",
		])
			expect(params).not.toHaveProperty(field);
		// No assistant prefill: the last turn is the user's.
		expect((params.messages as { role: string }[]).at(-1)?.role).toBe("user");
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	test("max_tokens is the larger of the request and 16000, unless set", async () => {
		const big = setup();
		await big.complete({ maxOutputTokens: 20_000 });
		expect(big.requests[0]?.params.max_tokens).toBe(20_000);
		const fixed = setup(() => message(), {
			...DEFAULT_CLAUDE_SETTINGS,
			maxTokens: 4000,
		});
		await fixed.complete({ maxOutputTokens: 20_000 });
		expect(fixed.requests[0]?.params.max_tokens).toBe(4000);
	});

	test("the configured effort and model are sent as they are", async () => {
		const { complete, requests, port } = setup(() => message(), {
			model: "claude-haiku-5-5",
			effort: "high",
		});
		await complete();
		expect(requests[0]?.params.output_config).toEqual({ effort: "high" });
		expect(port.describe()).toEqual({
			provider: "anthropic",
			model: "claude-haiku-5-5",
			effort: "high",
		});
	});

	test("no system message means no system field", async () => {
		const { port, requests } = setup();
		await port.complete({
			messages: [{ role: "user", content: "hi" }],
			maxOutputTokens: 10,
			signal: new AbortController().signal,
		});
		expect(requests[0]?.params).not.toHaveProperty("system");
	});
});

describe("response", () => {
	test("takes the text blocks only and ignores thinking", async () => {
		const { complete } = setup(() =>
			message({
				content: [
					{ type: "thinking", thinking: "", signature: "sig" },
					{ type: "text", text: '{"a":' },
					{ type: "redacted_thinking", data: "x" },
					{ type: "text", text: "1}" },
				],
			}),
		);
		expect(await complete()).toMatchObject({ kind: "text", text: '{"a":1}' });
	});

	test("maps every usage counter, with the cache fields", async () => {
		const { complete } = setup();
		const outcome = await complete();
		expect(outcome.usage).toEqual({
			inputTokens: 120,
			outputTokens: 30,
			cacheReadInputTokens: 400,
			cacheCreationInputTokens: 50,
		});
		expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test("an unreported counter is null, never 0", async () => {
		const { complete } = setup(() =>
			message({
				usage: {
					input_tokens: 9,
					output_tokens: 2,
					cache_creation_input_tokens: null,
				},
			}),
		);
		expect((await complete()).usage).toEqual({
			inputTokens: 9,
			outputTokens: 2,
			cacheReadInputTokens: null,
			cacheCreationInputTokens: null,
		});
		const none = setup(() => message({ usage: undefined }));
		expect((await none.complete()).usage).toEqual({
			inputTokens: null,
			outputTokens: null,
			cacheReadInputTokens: null,
			cacheCreationInputTokens: null,
		});
	});

	const cases: [string, Params, string, string][] = [
		[
			"refusal without a category",
			{ stop_reason: "refusal", content: [] },
			"refused",
			"refusal",
		],
		[
			"refusal with a category",
			{
				stop_reason: "refusal",
				content: [],
				stop_details: { type: "refusal", category: "cyber", explanation: null },
			},
			"refused",
			"refusal:cyber",
		],
		[
			"refusal with a null category",
			{
				stop_reason: "refusal",
				content: [],
				stop_details: { type: "refusal", category: null, explanation: "x" },
			},
			"refused",
			"refusal",
		],
		[
			"cut at max_tokens (thinking used the budget)",
			{
				stop_reason: "max_tokens",
				content: [{ type: "thinking", thinking: "", signature: "s" }],
			},
			"malformed",
			"output_limit",
		],
		[
			"cut at max_tokens with partial text",
			{ stop_reason: "max_tokens", content: [{ type: "text", text: '{"a"' }] },
			"malformed",
			"output_limit",
		],
		[
			"context window exceeded",
			{ stop_reason: "model_context_window_exceeded" },
			"malformed",
			"model_context_window_exceeded",
		],
		["pause_turn", { stop_reason: "pause_turn" }, "malformed", "pause_turn"],
		[
			"stop_sequence",
			{ stop_reason: "stop_sequence" },
			"malformed",
			"stop_sequence",
		],
		["tool_use", { stop_reason: "tool_use" }, "malformed", "tool_use"],
		[
			"no text block",
			{ content: [{ type: "thinking", thinking: "", signature: "s" }] },
			"empty",
			"empty_output",
		],
		[
			"whitespace text",
			{ content: [{ type: "text", text: " \n" }] },
			"empty",
			"empty_output",
		],
	];
	for (const [name, overrides, kind, code] of cases)
		test(name, async () => {
			const { complete, events } = setup(() => message(overrides));
			const outcome = await complete();
			expect(outcome).toMatchObject({ kind, code });
			// The tokens of a failed call are still counted.
			expect(outcome.usage.outputTokens).toBe(30);
			expect(events.at(-1)).toMatchObject({ name: "inference.failed", code });
		});
});

describe("errors", () => {
	const generate = (status: number) =>
		Anthropic.APIError.generate(
			status,
			{ type: "error", error: { type: "x", message: `oops ${KEY}` } },
			`oops ${KEY}`,
			new Headers(),
		);
	const cases: [string, () => Error, string][] = [
		["401", () => generate(401), "http_401"],
		["429", () => generate(429), "http_429"],
		["400", () => generate(400), "http_400"],
		["403", () => generate(403), "http_403"],
		["500", () => generate(500), "http_500"],
		["529 (overloaded)", () => generate(529), "http_529"],
		[
			"connection timeout",
			() => new Anthropic.APIConnectionTimeoutError(),
			"deadline",
		],
		[
			"connection lost",
			() => new Anthropic.APIConnectionError({ message: "down" }),
			"transport_lost",
		],
		["user abort error", () => new Anthropic.APIUserAbortError(), "aborted"],
		["anything else", () => new Error(`boom ${KEY}`), "claude_failed"],
	];
	for (const [name, make, code] of cases)
		test(name, async () => {
			const { complete, events } = setup(() => {
				throw make();
			});
			const outcome = await complete();
			expect(outcome).toMatchObject({
				kind: "error",
				code,
				usage: { inputTokens: null, outputTokens: null },
			});
			expect(events.at(-1)).toMatchObject({ name: "inference.failed", code });
		});
});

describe("abort", () => {
	test("an already aborted signal sends nothing", async () => {
		const { complete, requests } = setup();
		const controller = new AbortController();
		controller.abort();
		expect(await complete({ signal: controller.signal })).toMatchObject({
			kind: "error",
			code: "aborted",
		});
		expect(requests).toHaveLength(0);
	});

	test("aborting during the call ends it as aborted and passes the signal on", async () => {
		const controller = new AbortController();
		const { complete } = setup(
			(_params, { signal }) =>
				new Promise((_, reject) => {
					signal?.addEventListener(
						"abort",
						() => reject(new Anthropic.APIUserAbortError()),
						{ once: true },
					);
					queueMicrotask(() => controller.abort());
				}),
		);
		expect(await complete({ signal: controller.signal })).toMatchObject({
			kind: "error",
			code: "aborted",
		});
	});

	test("a caller deadline (TimeoutError reason) is deadline", async () => {
		const controller = new AbortController();
		const { complete } = setup(
			(_params, { signal }) =>
				new Promise((_, reject) => {
					signal?.addEventListener(
						"abort",
						() => reject(new Anthropic.APIUserAbortError()),
						{ once: true },
					);
					queueMicrotask(() =>
						controller.abort(new DOMException("t", "TimeoutError")),
					);
				}),
		);
		expect(await complete({ signal: controller.signal })).toMatchObject({
			kind: "error",
			code: "deadline",
		});
	});
});

describe("cost estimate", () => {
	const usage = (u: Partial<InferenceUsage>): InferenceUsage => ({
		inputTokens: 0,
		outputTokens: 0,
		...u,
	});
	test("input and output at the list price", () => {
		// 100K tokens is the edge of the standard rates.
		expect(
			estimateClaudeCostUsd(
				"claude-haiku-5-5",
				usage({ inputTokens: 100_000, outputTokens: 1_000_000 }),
			),
		).toBeCloseTo(0.1 * 0.1 + 0.5, 10);
	});
	test("cache reads cost 0.1x and writes 1.25x the input price", () => {
		expect(
			estimateClaudeCostUsd(
				"claude-haiku-5-5",
				usage({
					cacheReadInputTokens: 50_000,
					cacheCreationInputTokens: 50_000,
				}),
			),
		).toBeCloseTo((50_000 * 0.1 * 0.1 + 50_000 * 0.1 * 1.25) / 1_000_000, 10);
	});
	test("a prompt above 100K tokens (cache included) uses the long rates", () => {
		expect(
			estimateClaudeCostUsd(
				"claude-haiku-5-5",
				usage({
					inputTokens: 50_000,
					cacheReadInputTokens: 60_000,
					outputTokens: 1_000_000,
				}),
			),
		).toBeCloseTo((50_000 * 0.5 + 60_000 * 0.05 + 2_500_000) / 1_000_000, 10);
	});
	test("unknown model or unknown tokens give null, unreported cache counts as none", () => {
		expect(estimateClaudeCostUsd("other-model", usage({}))).toBeNull();
		expect(
			estimateClaudeCostUsd(
				"claude-haiku-5-5",
				usage({ inputTokens: null, outputTokens: 5 }),
			),
		).toBeNull();
		expect(
			estimateClaudeCostUsd(
				"claude-haiku-5-5",
				usage({
					inputTokens: 100_000,
					cacheReadInputTokens: null,
					cacheCreationInputTokens: null,
				}),
			),
		).toBeCloseTo(0.01, 10);
	});
});

describe("secrets", () => {
	test("the key reaches neither logs nor outcomes", async () => {
		const all: unknown[] = [];
		for (const reply of [
			() => message(),
			() => {
				throw Anthropic.APIError.generate(
					401,
					{ error: { message: KEY } },
					`invalid x-api-key ${KEY}`,
					new Headers({ "x-api-key": KEY }),
				);
			},
			() => {
				throw new Error(`boom ${KEY}`);
			},
		]) {
			const { complete, events } = setup(reply);
			all.push(await complete(), events);
		}
		expect(JSON.stringify(all)).not.toContain(KEY);
	});

	test("events carry only a correlation id, a fixed code and a duration", async () => {
		const { complete, events } = setup();
		await complete();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			name: "inference.completed",
			correlationId: "corr-1",
			code: "text",
		});
		expect(Object.keys(events[0]!).sort()).toEqual([
			"code",
			"correlationId",
			"durationMs",
			"name",
		]);
	});

	test("a logger that throws never changes the result", async () => {
		const port = createClaudeInference({
			settings: DEFAULT_CLAUDE_SETTINGS,
			logger: {
				event() {
					throw new Error("sink down");
				},
			},
			correlationId: "c",
			client: {
				messages: { create: async () => message() },
			} as unknown as Pick<Anthropic, "messages">,
		});
		expect(
			(
				await port.complete({
					messages,
					maxOutputTokens: 10,
					signal: new AbortController().signal,
				})
			).kind,
		).toBe("text");
	});
});
