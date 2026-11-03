import { describe, expect, test } from "bun:test";
import type { InferenceOutcome, InferenceRequest } from "eumenes-interact";
import {
	createLarmInference,
	listLarmChatProfiles,
} from "../../inference/index.ts";
import {
	BASE,
	CONTROL_TOKEN,
	SETTINGS,
	fakeLarm,
	json,
	providerToken,
	recordingLogger,
	text,
} from "./fake-larm.ts";

const messages = [
	{ role: "system" as const, content: "rules" },
	{ role: "user" as const, content: "observe" },
];

function setup(
	configure?: (fake: ReturnType<typeof fakeLarm>) => void,
	clientId = "client-1",
) {
	const fake = fakeLarm();
	configure?.(fake);
	const log = recordingLogger();
	const port = createLarmInference({
		settings: SETTINGS,
		token: CONTROL_TOKEN,
		clientId,
		logger: log.logger,
		correlationId: "corr-1",
		fetch: fake.fetch,
	});
	const complete = (
		overrides: Partial<InferenceRequest> = {},
	): Promise<InferenceOutcome> =>
		port.complete({
			messages,
			maxOutputTokens: 1024,
			signal: new AbortController().signal,
			...overrides,
		});
	return { fake, port, complete, ...log };
}

describe("listLarmChatProfiles", () => {
	test("keeps default, non-deprecated Profiles with an llm Provider", async () => {
		const fake = fakeLarm();
		const profiles = await listLarmChatProfiles({
			baseUrl: BASE,
			token: CONTROL_TOKEN,
			signal: new AbortController().signal,
			fetch: fake.fetch,
		});
		expect(profiles).toEqual([
			{ name: "chat-a", description: "First chat profile" },
			{ name: "chat-b" },
		]);
		// Without a Profile selector, with the control credential only.
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.search).toBe("");
		expect(fake.calls[0]?.headers.get("authorization")).toBe(
			`Bearer ${CONTROL_TOKEN}`,
		);
	});

	test("an unreadable catalog is a fixed-code error without the token", async () => {
		const error = await listLarmChatProfiles({
			baseUrl: BASE,
			token: CONTROL_TOKEN,
			signal: new AbortController().signal,
			fetch: async () => json({ error: `bad ${CONTROL_TOKEN}` }, 401),
		}).catch((e: Error) => e);
		expect((error as Error).message).toBe("larm_control_401");
		expect(String(error)).not.toContain(CONTROL_TOKEN);
	});

	test("refuses a public address", async () => {
		const error = await listLarmChatProfiles({
			baseUrl: "https://example.com",
			token: CONTROL_TOKEN,
			signal: new AbortController().signal,
			fetch: fakeLarm().fetch,
		}).catch((e: Error) => e);
		expect((error as Error).message).toBe("larm_nonlocal_endpoint");
	});
});

describe("connection lifecycle", () => {
	test("creates once as a sub role, claims, and sends a plain chat", async () => {
		const { fake, complete, port } = setup();
		const outcome = await complete();
		expect(outcome).toMatchObject({
			kind: "text",
			text: "ok",
			usage: { inputTokens: 11, outputTokens: 3 },
		});
		const create = fake.calls.find(
			(c) => c.method === "POST" && c.path === "/v1/agent-connections",
		)!;
		expect(create.body).toEqual({
			profile: "chat-profile",
			client: "client-1",
			audience: "saaa-desktop",
			ttlSeconds: 900,
			allowFallback: false,
			deploymentPolicy: "existing-only",
			providers: ["llm"],
			expectedCatalogRevision: "rev1",
		});
		expect(create.body).not.toHaveProperty("contextTokens");
		expect(create.headers.get("idempotency-key")).toBeTruthy();
		expect(create.headers.get("prefer")).toBe("wait=1");
		expect(create.headers.get("authorization")).toBe(`Bearer ${CONTROL_TOKEN}`);
		expect(create.init.compress).toBe(false);
		const claim = fake.calls.find((c) => c.path.endsWith("/claim"))!;
		expect(claim.body).toEqual({
			format: "openai-provider-v1",
			providers: ["llm"],
		});
		const [chat] = fake.chats();
		expect(chat?.body).toEqual({
			model: "model-from-catalog",
			prompt_cache_key: expect.stringMatching(/^[0-9a-f]{64}$/),
			messages,
			stream: false,
			max_tokens: 1024,
		});
		expect(chat?.body).not.toHaveProperty("response_format");
		// The claimed credential, not the control token; no LARM-specific headers.
		expect(chat?.headers.get("authorization")).toBe(
			`Bearer ${providerToken(1)}`,
		);
		expect([...chat!.headers.keys()].sort()).toEqual([
			"accept-encoding",
			"authorization",
			"content-type",
		]);
		expect(chat?.init.compress).toBe("gzip");
		expect(port.describe()).toEqual({
			profile: "chat-profile",
			model: "model-from-catalog",
		});
	});

	test("reuses the connection and the prompt cache key", async () => {
		const { fake, complete } = setup();
		await complete();
		await complete();
		expect(fake.count("POST", "/v1/agent-connections")).toBe(1);
		expect(fake.count("POST", "/v1/agent-connections/connection-1/claim")).toBe(
			1,
		);
		const [a, b] = fake.chats();
		expect(a?.body?.prompt_cache_key).toBe(b?.body?.prompt_cache_key);
	});

	test("waits for claimable through the health check", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.claimable = false;
		});
		expect((await complete()).kind).toBe("text");
		expect(
			fake.count(
				"GET",
				"/v1/agent-connections/connection-1/providers/llm/health",
			),
		).toBe(1);
	});

	test("renews and re-claims close to expiry, then uses the new credential", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.connectionTtlMs = 120_000;
		});
		await complete();
		await complete();
		expect(fake.count("POST", "/v1/agent-connections")).toBe(1);
		const renew = fake.calls.find((c) => c.path.endsWith("/renew"))!;
		expect(renew.body).toEqual({ ttlSeconds: 900 });
		expect(renew.headers.get("idempotency-key")).toBeTruthy();
		expect(fake.count("POST", "/v1/agent-connections/connection-1/claim")).toBe(
			2,
		);
		const [first, second] = fake.chats();
		expect(first?.headers.get("authorization")).toBe(
			`Bearer ${providerToken(1)}`,
		);
		expect(second?.headers.get("authorization")).toBe(
			`Bearer ${providerToken(2)}`,
		);
	});

	test("recreates when the bootEpoch changed", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.connectionTtlMs = 120_000;
		});
		await complete();
		// LARM restarted: the same connection id now reports another epoch, and a new one is created.
		const old = fake.bindings[0]!;
		old.epoch = "epoch-b";
		old.released = true;
		expect((await complete()).kind).toBe("text");
		expect(fake.count("POST", "/v1/agent-connections")).toBe(2);
		// The ended connection is not released again.
		expect(fake.count("DELETE", "/v1/agent-connections/connection-1")).toBe(0);
	});

	test("recreates when the connection is gone", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.connectionTtlMs = 120_000;
		});
		await complete();
		fake.knobs.getStatus = 404;
		fake.knobs.connectionTtlMs = 900_000;
		fake.bindings[0]!.released = true;
		expect((await complete()).kind).toBe("text");
		expect(fake.count("POST", "/v1/agent-connections")).toBe(2);
	});

	test("a claimed capacity other than the sub role's is refused and released", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.capacity = 200_000;
		});
		expect(await complete()).toMatchObject({
			kind: "error",
			code: "larm_agent_context_mismatch",
		});
		expect(fake.chats()).toHaveLength(0);
		expect(fake.count("DELETE", "/v1/agent-connections/connection-1")).toBe(1);
	});

	test("a claim beyond the catalog capacity is refused", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.catalogCapacity = 100_000;
		});
		expect(await complete()).toMatchObject({
			kind: "error",
			code: "larm_claim_context_mismatch",
		});
		expect(fake.chats()).toHaveLength(0);
	});

	test("a provider on another host never receives the credential", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.claimBase = "http://10.1.2.3:9000/v1";
		});
		expect(await complete()).toMatchObject({
			kind: "error",
			code: "larm_provider_host_mismatch",
		});
		expect(fake.chats()).toHaveLength(0);
	});

	test("close releases what it created once, and is idempotent", async () => {
		const { fake, complete, port, events } = setup();
		await complete();
		await Promise.all([port.close(), port.close()]);
		await port.close();
		expect(fake.count("DELETE", "/v1/agent-connections/connection-1")).toBe(1);
		expect(events.filter((e) => e.name === "inference.released")).toHaveLength(
			1,
		);
		expect(await complete()).toMatchObject({
			kind: "error",
			code: "larm_closed",
		});
	});

	test("close without a connection releases nothing", async () => {
		const { fake, port } = setup();
		await port.close();
		expect(fake.calls).toHaveLength(0);
	});
});

describe("max_tokens", () => {
	test("a legacy claim caps the output at its reserve", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.outputReserve = 512;
		});
		await complete({ maxOutputTokens: 2048 });
		expect(fake.chats()[0]?.body?.max_tokens).toBe(512);
	});

	test("remaining-context takes the request's bound", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.outputReserve = 512;
			f.knobs.outputLimit = "remaining-context";
		});
		await complete({ maxOutputTokens: 2048 });
		expect(fake.chats()[0]?.body?.max_tokens).toBe(2048);
	});
});

describe("classification", () => {
	test("usage is null, never 0, when not reported", async () => {
		const { complete } = setup((f) => {
			f.knobs.chat = () => text("answer");
		});
		expect(await complete()).toMatchObject({
			kind: "text",
			usage: { inputTokens: null, outputTokens: null },
		});
	});

	test("a partly reported usage keeps the unknown side null", async () => {
		const { complete } = setup((f) => {
			f.knobs.chat = () => text("answer", { prompt_tokens: 7 });
		});
		expect((await complete()).usage).toEqual({
			inputTokens: 7,
			outputTokens: null,
		});
	});

	const cases: [string, () => Response, string, string][] = [
		[
			"content filter",
			() =>
				json({
					choices: [
						{
							index: 0,
							message: { content: "" },
							finish_reason: "content_filter",
						},
					],
					usage: { prompt_tokens: 5, completion_tokens: 0 },
				}),
			"refused",
			"content_filter",
		],
		[
			"refusal field",
			() =>
				json({
					choices: [{ index: 0, message: { content: null, refusal: "no" } }],
				}),
			"refused",
			"refusal",
		],
		[
			"empty content",
			() => json({ choices: [{ index: 0, message: { content: "" } }] }),
			"empty",
			"empty_output",
		],
		[
			"whitespace only",
			() => json({ choices: [{ index: 0, message: { content: " \n" } }] }),
			"empty",
			"empty_output",
		],
		[
			"missing content",
			() => json({ choices: [{ index: 0, message: {} }] }),
			"empty",
			"empty_output",
		],
		[
			"cut at the token limit",
			() =>
				json({
					choices: [
						{ index: 0, message: { content: '{"a"' }, finish_reason: "length" },
					],
				}),
			"malformed",
			"output_limit",
		],
		["not JSON", () => new Response("<html>"), "malformed", "invalid_json"],
		["no choices", () => json({ choices: [] }), "malformed", "no_choice"],
		[
			"error field in a 200",
			() => json({ error: { message: "x" } }),
			"malformed",
			"provider_error_field",
		],
		[
			"content of the wrong type",
			() => json({ choices: [{ index: 0, message: { content: [1] } }] }),
			"malformed",
			"invalid_content",
		],
		[
			"HTTP 503",
			() => json({ error: { code: "resource_exhausted" } }, 503),
			"error",
			"http_503",
		],
		["HTTP 400", () => json({ error: "bad" }, 400), "error", "http_400"],
	];
	for (const [name, answer, kind, code] of cases)
		test(name, async () => {
			const { fake, complete, events } = setup((f) => {
				f.knobs.chat = answer;
			});
			const outcome = await complete();
			expect(outcome).toMatchObject({ kind, code });
			expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
			// Classified per call, and never resent.
			expect(fake.chats()).toHaveLength(1);
			expect(events.at(-1)).toMatchObject({ name: "inference.failed", code });
		});

	test("the usage of a refused answer is kept", async () => {
		const { complete } = setup((f) => {
			f.knobs.chat = () =>
				json({
					choices: [
						{
							index: 0,
							message: { content: "" },
							finish_reason: "content_filter",
						},
					],
					usage: { prompt_tokens: 5, completion_tokens: 0 },
				});
		});
		expect((await complete()).usage).toEqual({
			inputTokens: 5,
			outputTokens: 0,
		});
	});
});

describe("never resent", () => {
	test("a transport loss before the response is transport_lost, sent once", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.chat = () => {
				throw new TypeError("fetch failed");
			};
		});
		expect(await complete()).toMatchObject({
			kind: "error",
			code: "transport_lost",
		});
		expect(fake.chats()).toHaveLength(1);
		expect(fake.count("POST", "/v1/agent-connections")).toBe(1);
	});

	test("a stream lost while reading the response is transport_lost, sent once", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.chat = () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"choices":'));
							controller.error(new TypeError("terminated"));
						},
					}),
				);
		});
		expect(await complete()).toMatchObject({
			kind: "error",
			code: "transport_lost",
		});
		expect(fake.chats()).toHaveLength(1);
	});

	test("a refusal LARM made before inference (idle release) is sent once more on a new connection", async () => {
		let n = 0;
		const { fake, complete } = setup((f) => {
			f.knobs.chat = () =>
				++n === 1
					? json({ error: { code: "connection_idle_released" } }, 409)
					: text("after reconnect");
		});
		const outcome = await complete();
		expect(outcome).toMatchObject({ kind: "text", text: "after reconnect" });
		expect(fake.chats()).toHaveLength(2);
		expect(fake.count("POST", "/v1/agent-connections")).toBe(2);
	});

	test("a second idle-release refusal ends as http_409", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.chat = () =>
				json({ error: { code: "connection_idle_released" } }, 409);
		});
		expect(await complete()).toMatchObject({ kind: "error", code: "http_409" });
		expect(fake.chats()).toHaveLength(2);
	});

	test("other rejections are not replayed", async () => {
		const { fake, complete } = setup((f) => {
			f.knobs.chat = () => json({ error: { code: "overloaded" } }, 500);
		});
		expect(await complete()).toMatchObject({ kind: "error", code: "http_500" });
		expect(fake.chats()).toHaveLength(1);
	});
});

describe("abort and deadline", () => {
	test("an already aborted signal sends nothing", async () => {
		const { fake, complete } = setup();
		const controller = new AbortController();
		controller.abort();
		expect(await complete({ signal: controller.signal })).toMatchObject({
			kind: "error",
			code: "aborted",
		});
		expect(fake.calls).toHaveLength(0);
	});

	test("aborting during generation ends the call as aborted", async () => {
		const controller = new AbortController();
		const { complete, events } = setup((f) => {
			f.knobs.chat = (_call, signal) =>
				new Promise<Response>((_, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
					queueMicrotask(() => controller.abort());
				});
		});
		expect(await complete({ signal: controller.signal })).toMatchObject({
			kind: "error",
			code: "aborted",
		});
		expect(events.at(-1)).toMatchObject({ code: "aborted" });
	});

	test("a caller deadline (TimeoutError reason) is recorded as deadline", async () => {
		const controller = new AbortController();
		const { complete, fake } = setup((f) => {
			f.knobs.chat = (_call, signal) =>
				new Promise<Response>((_, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
					queueMicrotask(() =>
						controller.abort(new DOMException("deadline", "TimeoutError")),
					);
				});
		});
		expect(await complete({ signal: controller.signal })).toMatchObject({
			kind: "error",
			code: "deadline",
		});
		expect(fake.chats()).toHaveLength(1);
	});

	test("a deadline during the connection is deadline and sends no generation", async () => {
		const controller = new AbortController();
		const { fake } = setup();
		const original = fake.fetch;
		const slow = createLarmInference({
			settings: SETTINGS,
			token: CONTROL_TOKEN,
			clientId: "client-x",
			logger: recordingLogger().logger,
			correlationId: "c",
			fetch: (input, init) => {
				if (new URL(String(input)).pathname === "/v3/agent-profiles")
					controller.abort(new DOMException("deadline", "TimeoutError"));
				return original(input, init);
			},
		});
		const outcome = await slow.complete({
			messages,
			maxOutputTokens: 10,
			signal: controller.signal,
		});
		expect(outcome).toMatchObject({ kind: "error", code: "deadline" });
		expect(fake.chats()).toHaveLength(0);
	});

	test("close aborts a call in flight and releases afterwards", async () => {
		const { fake, complete, port } = setup((f) => {
			f.knobs.chat = (_call, signal) =>
				new Promise<Response>((_, reject) =>
					signal?.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					}),
				);
		});
		const running = complete();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await port.close();
		expect(await running).toMatchObject({ kind: "error", code: "larm_closed" });
		expect(fake.count("DELETE", "/v1/agent-connections/connection-1")).toBe(1);
	});
});

describe("serialization", () => {
	test("calls of one session infer one at a time", async () => {
		let active = 0;
		let peak = 0;
		const { fake, complete } = setup((f) => {
			f.knobs.chat = async () => {
				peak = Math.max(peak, ++active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active--;
				return text("ok");
			};
		});
		await Promise.all([complete(), complete(), complete()]);
		expect(peak).toBe(1);
		expect(fake.chats()).toHaveLength(3);
		expect(fake.count("POST", "/v1/agent-connections")).toBe(1);
	});
});

describe("secrets", () => {
	test("tokens reach neither logs nor error codes, on success and on failure", async () => {
		const all: unknown[] = [];
		for (const answer of [
			() => text("fine", { prompt_tokens: 1, completion_tokens: 1 }),
			() =>
				json(
					{ error: { message: `oops ${CONTROL_TOKEN} ${providerToken(1)}` } },
					500,
				),
			() => {
				throw new TypeError(`fetch failed ${CONTROL_TOKEN}`);
			},
		]) {
			const { complete, port, events } = setup((f) => {
				f.knobs.chat = answer;
			});
			all.push(await complete());
			await port.close();
			all.push(events);
		}
		const dump = JSON.stringify(all);
		expect(dump).not.toContain(CONTROL_TOKEN);
		expect(dump).not.toContain("provider-token");
	});

	test("a control failure carries a fixed code only", async () => {
		const fake = fakeLarm();
		const port = createLarmInference({
			settings: SETTINGS,
			token: CONTROL_TOKEN,
			clientId: "c",
			logger: recordingLogger().logger,
			correlationId: "c",
			fetch: async () => json({ error: `denied ${CONTROL_TOKEN}` }, 401),
		});
		const outcome = await port.complete({
			messages,
			maxOutputTokens: 10,
			signal: new AbortController().signal,
		});
		expect(outcome).toMatchObject({ kind: "error", code: "larm_control_401" });
		expect(JSON.stringify(outcome)).not.toContain(CONTROL_TOKEN);
		expect(fake.calls).toHaveLength(0);
	});

	test("logged events carry only a correlation id, a fixed code and a duration", async () => {
		const { complete, port, events } = setup();
		await complete();
		await port.close();
		expect(events.map((e) => e.name)).toEqual([
			"inference.connected",
			"inference.completed",
			"inference.released",
		]);
		for (const event of events) {
			expect(event.correlationId).toBe("corr-1");
			expect(Object.keys(event).sort()).toEqual(
				[
					"correlationId",
					"name",
					...(event.code ? ["code"] : []),
					...(event.durationMs === undefined ? [] : ["durationMs"]),
				].sort(),
			);
		}
	});

	test("a logger that throws never changes the result", async () => {
		const fake = fakeLarm();
		const port = createLarmInference({
			settings: SETTINGS,
			token: CONTROL_TOKEN,
			clientId: "c",
			logger: {
				event() {
					throw new Error("log sink down");
				},
			},
			correlationId: "c",
			fetch: fake.fetch,
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

describe("configuration", () => {
	const make = (
		settings: { baseUrl: string; profile: string },
		token = CONTROL_TOKEN,
	) =>
		createLarmInference({
			settings,
			token,
			clientId: "c",
			logger: recordingLogger().logger,
			correlationId: "c",
			fetch: fakeLarm().fetch,
		});
	test("a missing token, Profile or a public address is refused up front", () => {
		expect(() => make(SETTINGS, " ")).toThrow("larm_unconfigured");
		expect(() => make({ ...SETTINGS, profile: "" })).toThrow(
			"larm_profile_missing",
		);
		expect(() => make({ ...SETTINGS, baseUrl: "https://example.com" })).toThrow(
			"larm_nonlocal_endpoint",
		);
		expect(() => make({ ...SETTINGS, baseUrl: "not a url" })).toThrow(
			"larm_base_url_invalid",
		);
	});
});
