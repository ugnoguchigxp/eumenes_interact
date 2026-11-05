import { test, expect } from "bun:test";
import { createOpenAIInference } from "../../inference/openai.ts";
const request = {
	messages: [{ role: "user" as const, content: "test" }],
	maxOutputTokens: 500,
	signal: new AbortController().signal,
	outputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const reply = {
	status: "completed",
	output: [
		{
			type: "message",
			content: [{ type: "output_text", text: '{"ok":true}' }],
		},
	],
	usage: {
		input_tokens: 100,
		output_tokens: 10,
		input_tokens_details: { cached_tokens: 0 },
	},
};

test("cache hits are normalized as uncached input plus cache reads, with no double count", async () => {
	const out = await createOpenAIInference({
		apiKey: "test",
		fetch: async () =>
			Response.json({
				...reply,
				usage: {
					input_tokens: 1000,
					output_tokens: 10,
					input_tokens_details: { cached_tokens: 800 },
				},
			}),
	}).complete(request);
	expect(out.usage.inputTokens).toBe(200);
	expect(out.usage.cacheReadInputTokens).toBe(800);
});

test("Responses uses the requested schema, fixed model and no storage or tools", async () => {
	let body: Record<string, unknown> = {};
	const port = createOpenAIInference({
		apiKey: "secret-test",
		fetch: async (url, init) => {
			expect(String(url)).toBe("https://api.openai.com/v1/responses");
			expect(init?.redirect).toBe("error");
			body = JSON.parse(String(init?.body));
			return Response.json(reply);
		},
	});
	expect((await port.complete(request)).kind).toBe("text");
	expect(body).toMatchObject({
		model: "gpt-6-luna",
		store: false,
		max_output_tokens: 500,
		text: { format: { strict: true, schema: request.outputSchema } },
	});
	expect(body).not.toHaveProperty("tools");
});

test("errors never expose upstream bodies or credentials and never retry", async () => {
	let calls = 0;
	const port = createOpenAIInference({
		apiKey: "secret-test",
		fetch: async () => {
			calls++;
			return new Response("secret-test", { status: 429 });
		},
	});
	const outcome = await port.complete(request);
	expect(outcome).toMatchObject({
		kind: "error",
		code: "http_429",
		usage: { inputTokens: null },
	});
	expect(JSON.stringify(outcome)).not.toContain("secret-test");
	expect(calls).toBe(1);
});

test("incomplete, refusal and absent usage remain separate from success", async () => {
	for (const [body, expected] of [
		[{ ...reply, status: "incomplete" }, "malformed"],
		[
			{
				...reply,
				output: [{ type: "message", content: [{ type: "refusal" }] }],
			},
			"refused",
		],
		[{ ...reply, output: [] }, "empty"],
	] as const) {
		const out = await createOpenAIInference({
			apiKey: "test",
			fetch: async () => Response.json(body),
		}).complete(request);
		expect(out.kind).toBe(expected);
	}
});
