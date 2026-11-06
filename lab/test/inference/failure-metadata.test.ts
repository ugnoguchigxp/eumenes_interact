import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type {
	InferenceOutcome,
	InferencePort,
	InferenceRequest,
} from "eumenes-interact";
import {
	DEFAULT_CLAUDE_SETTINGS,
	createClaudeInference,
} from "../../inference/index.ts";
import { createOpenAIInference, LUNA_MODEL } from "../../inference/openai.ts";
import {
	SpendLedger,
	budgetedInference,
	type PaidModel,
} from "../../inference/spend.ts";
import { recordingLogger } from "./fake-larm.ts";

/**
 * Every outcome of a provider call, failed or not, carries the requested provider/model/effort and
 * the attempt count; a failure never invents a returned model; the spend ledger keeps a call with
 * unknown usage reserved. No network: the SDK client and `fetch` are injected.
 */

type Row = {
	model: string;
	reserved: number;
	charged: number | null;
	state: string;
};

let dir: string;
let path: string;
let ledger: SpendLedger;
let view: Database;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "failure-metadata-"));
	path = join(dir, "spend.sqlite");
	ledger = new SpendLedger(path, 10);
	view = new Database(path, { readonly: true });
});
afterEach(() => {
	view.close();
	ledger.close();
	rmSync(dir, { recursive: true, force: true });
});

const rows = () =>
	view
		.query("SELECT model, reserved, charged, state FROM spend_calls")
		.all() as Row[];

const request = (
	overrides: Partial<InferenceRequest> = {},
): InferenceRequest => ({
	messages: [{ role: "user", content: "hi" }],
	maxOutputTokens: 500,
	signal: new AbortController().signal,
	...overrides,
});

/** The outcome plus the ledger row of the one call that went through the budgeted port. */
async function run(
	inner: InferencePort,
	model: PaidModel,
	overrides: Partial<InferenceRequest> = {},
) {
	const outcome = await budgetedInference(inner, ledger, model).complete(
		request(overrides),
	);
	expect(rows()).toHaveLength(1);
	return { outcome, row: rows()[0]! };
}

/** Usage unknown: the whole reservation stays, the call is never free. */
function expectStillReserved(row: Row, model: PaidModel) {
	expect(row.model).toBe(model);
	expect(row.state).toBe("reserved");
	expect(row.charged).toBeNull();
	expect(row.reserved).toBeGreaterThan(0);
	expect(ledger.summary().unknownCalls).toBe(1);
	expect(ledger.summary().accountedUpperUsd).toBe(row.reserved / 1_000_000);
}

function expectSettled(row: Row, model: PaidModel) {
	expect(row.model).toBe(model);
	expect(row.state).toBe("settled");
	expect(row.charged).not.toBeNull();
	expect(row.charged!).toBeLessThan(row.reserved);
	expect(ledger.summary().unknownCalls).toBe(0);
}

function metadataOf(outcome: InferenceOutcome) {
	expect(outcome.metadata).toBeDefined();
	return outcome.metadata!;
}

describe("anthropic", () => {
	const message = (overrides: Record<string, unknown> = {}) => ({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-haiku-5-5-returned",
		content: [{ type: "text", text: '{"ok":true}' }],
		stop_reason: "end_turn",
		stop_details: null,
		stop_sequence: null,
		usage: {
			input_tokens: 120,
			output_tokens: 30,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			service_tier: "standard",
		},
		...overrides,
	});
	const port = (create: (...args: unknown[]) => unknown) => {
		let sent = 0;
		const inner = createClaudeInference({
			settings: DEFAULT_CLAUDE_SETTINGS,
			logger: recordingLogger().logger,
			correlationId: "c",
			client: {
				messages: {
					create: async (...args: unknown[]) => {
						sent++;
						return create(...args);
					},
				},
			} as unknown as Pick<Anthropic, "messages">,
		});
		return { inner, sent: () => sent };
	};
	const requested = {
		provider: "anthropic",
		requestedModel: "claude-haiku-5-5",
		requestedEffort: "low",
	};
	const MODEL = "claude-haiku-5-5";

	const apiError = (status: number) =>
		Anthropic.APIError.generate(
			status,
			{ type: "error", error: { type: "x", message: "oops" } },
			"oops",
			new Headers(),
		);

	for (const status of [400, 401, 429, 500, 529])
		test(`HTTP ${status}: requested identity and one attempt, no returned model, reservation kept`, async () => {
			const { inner, sent } = port(() => {
				throw apiError(status);
			});
			const { outcome, row } = await run(inner, MODEL);
			expect(outcome).toMatchObject({ kind: "error", code: `http_${status}` });
			expect(metadataOf(outcome)).toEqual({
				...requested,
				returnedModel: null,
				responseId: null,
				serviceTier: null,
				httpAttempts: 1,
			});
			expect(sent()).toBe(1);
			expectStillReserved(row, MODEL);
		});

	test("transport loss and unknown exceptions record the same way", async () => {
		for (const failure of [
			new Anthropic.APIConnectionError({ message: "down" }),
			new Anthropic.APIConnectionTimeoutError(),
			new Error("boom"),
		]) {
			const { inner } = port(() => {
				throw failure;
			});
			const { outcome } = await run(inner, MODEL);
			expect(outcome.kind).toBe("error");
			expect(metadataOf(outcome)).toMatchObject({
				...requested,
				returnedModel: null,
				httpAttempts: 1,
			});
			ledger.close();
			view.close();
			rmSync(path);
			ledger = new SpendLedger(path, 10);
			view = new Database(path, { readonly: true });
		}
	});

	test("an abort during the call is recorded as one dispatched attempt", async () => {
		const controller = new AbortController();
		const { inner } = port(
			(_params, options) =>
				new Promise((_, reject) => {
					(options as { signal: AbortSignal }).signal.addEventListener(
						"abort",
						() => reject(new Anthropic.APIUserAbortError()),
						{ once: true },
					);
					queueMicrotask(() => controller.abort());
				}),
		);
		const { outcome, row } = await run(inner, MODEL, {
			signal: controller.signal,
		});
		expect(outcome).toMatchObject({ kind: "error", code: "aborted" });
		expect(metadataOf(outcome)).toMatchObject({
			...requested,
			returnedModel: null,
			httpAttempts: 1,
		});
		expectStillReserved(row, MODEL);
	});

	test("an abort before sending records zero attempts (the budgeted wrapper reserves nothing)", async () => {
		const controller = new AbortController();
		controller.abort();
		const { inner, sent } = port(() => message());
		const outcome = await inner.complete(
			request({ signal: controller.signal }),
		);
		expect(outcome).toMatchObject({ kind: "error", code: "aborted" });
		expect(metadataOf(outcome)).toMatchObject({
			...requested,
			returnedModel: null,
			httpAttempts: 0,
		});
		expect(sent()).toBe(0);
	});

	test("a schema refused before sending records zero attempts, and the reservation stays", async () => {
		const { inner, sent } = port(() => message());
		const { outcome, row } = await run(inner, MODEL, {
			outputSchema: { type: "array" },
		});
		expect(outcome).toMatchObject({
			kind: "error",
			code: "output_schema_invalid",
		});
		expect(metadataOf(outcome)).toEqual({
			...requested,
			returnedModel: null,
			responseId: null,
			serviceTier: null,
			httpAttempts: 0,
		});
		expect(sent()).toBe(0);
		expectStillReserved(row, MODEL);
	});

	const answered: [string, Record<string, unknown>, string, string][] = [
		["refused", { stop_reason: "refusal", content: [] }, "refused", "refusal"],
		[
			"empty",
			{ content: [{ type: "text", text: " " }] },
			"empty",
			"empty_output",
		],
		[
			"cut at max_tokens",
			{ stop_reason: "max_tokens" },
			"malformed",
			"output_limit",
		],
	];
	for (const [name, overrides, kind, code] of answered)
		test(`${name}: the answered response's identity and known usage are kept`, async () => {
			const { inner } = port(() => message(overrides));
			const { outcome, row } = await run(inner, MODEL);
			expect(outcome).toMatchObject({ kind, code });
			expect(metadataOf(outcome)).toEqual({
				...requested,
				returnedModel: "claude-haiku-5-5-returned",
				responseId: "msg_1",
				serviceTier: "standard",
				httpAttempts: 1,
			});
			expectSettled(row, MODEL);
		});

	test("a response without usage stays reserved even though the model answered", async () => {
		const { inner } = port(() =>
			message({ stop_reason: "refusal", content: [], usage: undefined }),
		);
		const { outcome, row } = await run(inner, MODEL);
		expect(outcome.kind).toBe("refused");
		expect(metadataOf(outcome).returnedModel).toBe("claude-haiku-5-5-returned");
		expect(outcome.usage.inputTokens).toBeNull();
		expectStillReserved(row, MODEL);
	});
});

describe("openai", () => {
	const reply = {
		id: "resp_1",
		model: "gpt-6-luna-returned",
		service_tier: "default",
		status: "completed",
		output: [
			{ type: "message", content: [{ type: "output_text", text: "{}" }] },
		],
		usage: {
			input_tokens: 100,
			output_tokens: 10,
			input_tokens_details: { cached_tokens: 0 },
		},
	};
	const requested = {
		provider: "openai",
		requestedModel: LUNA_MODEL,
		requestedEffort: "low",
	};
	const port = (fetch: (...args: never[]) => Promise<Response>) => {
		let sent = 0;
		const inner = createOpenAIInference({
			apiKey: "test-key",
			fetch: ((...args: never[]) => {
				sent++;
				return fetch(...args);
			}) as never,
		});
		return { inner, sent: () => sent };
	};

	for (const status of [400, 401, 429, 500])
		test(`HTTP ${status}: requested identity and one attempt, no returned model, reservation kept`, async () => {
			const { inner, sent } = port(
				async () => new Response("secret body", { status }),
			);
			const { outcome, row } = await run(inner, LUNA_MODEL);
			expect(outcome).toMatchObject({ kind: "error", code: `http_${status}` });
			expect(metadataOf(outcome)).toEqual({
				...requested,
				returnedModel: null,
				responseId: null,
				serviceTier: null,
				httpAttempts: 1,
			});
			expect(JSON.stringify(outcome)).not.toContain("secret body");
			expect(sent()).toBe(1);
			expectStillReserved(row, LUNA_MODEL);
		});

	test("a transport failure and an unparseable body record one attempt and no returned model", async () => {
		for (const make of [
			async () => {
				throw new TypeError("network down");
			},
			async () => new Response("not json", { status: 200 }),
		]) {
			const { inner } = port(make);
			const { outcome, row } = await run(inner, LUNA_MODEL);
			expect(outcome).toMatchObject({
				kind: "error",
				code: "openai_transport_or_contract",
			});
			expect(metadataOf(outcome)).toEqual({
				...requested,
				returnedModel: null,
				responseId: null,
				serviceTier: null,
				httpAttempts: 1,
			});
			expectStillReserved(row, LUNA_MODEL);
			ledger.close();
			view.close();
			rmSync(path);
			ledger = new SpendLedger(path, 10);
			view = new Database(path, { readonly: true });
		}
	});

	test("an abort during the call records one dispatched attempt", async () => {
		const controller = new AbortController();
		const { inner } = port(
			(_url: never, init: never) =>
				new Promise<Response>((_, reject) => {
					(init as RequestInit).signal!.addEventListener(
						"abort",
						() => reject(new DOMException("aborted", "AbortError")),
						{ once: true },
					);
					queueMicrotask(() => controller.abort());
				}),
		);
		const { outcome, row } = await run(inner, LUNA_MODEL, {
			signal: controller.signal,
		});
		expect(outcome).toMatchObject({ kind: "error", code: "aborted" });
		expect(metadataOf(outcome)).toMatchObject({
			...requested,
			returnedModel: null,
			httpAttempts: 1,
		});
		expectStillReserved(row, LUNA_MODEL);
	});

	test("an abort before sending records zero attempts", async () => {
		const controller = new AbortController();
		controller.abort();
		const { inner, sent } = port(async () => Response.json(reply));
		const outcome = await inner.complete(
			request({ signal: controller.signal }),
		);
		expect(outcome).toMatchObject({ kind: "error", code: "aborted" });
		expect(metadataOf(outcome)).toMatchObject({
			...requested,
			returnedModel: null,
			httpAttempts: 0,
		});
		expect(sent()).toBe(0);
		// The budgeted wrapper refuses an already aborted call before reserving anything.
		await expect(
			budgetedInference(inner, ledger, LUNA_MODEL).complete(
				request({ signal: controller.signal }),
			),
		).rejects.toThrow();
		expect(rows()).toHaveLength(0);
	});

	const answered: [string, Record<string, unknown>, string, string][] = [
		[
			"refused",
			{
				...reply,
				output: [{ type: "message", content: [{ type: "refusal" }] }],
			},
			"refused",
			"refusal",
		],
		["empty", { ...reply, output: [] }, "empty", "empty_output"],
		[
			"incomplete",
			{ ...reply, status: "incomplete" },
			"malformed",
			"output_limit",
		],
		["failed", { ...reply, status: "failed" }, "malformed", "response_failed"],
	];
	for (const [name, body, kind, code] of answered)
		test(`${name}: the answered response's identity and known usage are kept`, async () => {
			const { inner } = port(async () => Response.json(body));
			const { outcome, row } = await run(inner, LUNA_MODEL);
			expect(outcome).toMatchObject({ kind, code });
			expect(metadataOf(outcome)).toEqual({
				...requested,
				returnedModel: "gpt-6-luna-returned",
				responseId: "resp_1",
				serviceTier: "default",
				httpAttempts: 1,
			});
			expectSettled(row, LUNA_MODEL);
		});

	test("a non-string returned model is unknown, not stringified", async () => {
		const { inner } = port(async () =>
			Response.json({ ...reply, output: [], model: 7, id: {} }),
		);
		const { outcome } = await run(inner, LUNA_MODEL);
		expect(metadataOf(outcome)).toMatchObject({
			returnedModel: null,
			responseId: null,
		});
	});

	test("a response without usage stays reserved", async () => {
		const { inner } = port(async () =>
			Response.json({ ...reply, output: [], usage: undefined }),
		);
		const { outcome, row } = await run(inner, LUNA_MODEL);
		expect(outcome.kind).toBe("empty");
		expect(metadataOf(outcome).returnedModel).toBe("gpt-6-luna-returned");
		expectStillReserved(row, LUNA_MODEL);
	});
});
