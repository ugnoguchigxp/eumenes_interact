import type { InteractLogFields, LoggerPort } from "eumenes-interact";

/** Control and provider secrets of the fake; tests check they never reach a log or an error. */
export const CONTROL_TOKEN = "control-token-0123";
export const providerToken = (version: number) => `provider-token-${version}`;
export const BASE = "http://127.0.0.1:9810";
export const SETTINGS = { baseUrl: BASE, profile: "chat-profile" };

export type Call = {
	method: string;
	path: string;
	search: string;
	headers: Headers;
	body: Record<string, unknown> | undefined;
	init: Record<string, unknown>;
};

type Binding = {
	id: string;
	client: string;
	epoch: string;
	expiresAt: number;
	version: number;
	status: string;
	released: boolean;
};

const json = (value: unknown, status = 200) => Response.json(value, { status });

/** An in-memory LARM control plane and chat endpoint behind an injectable fetch. No network. */
export function fakeLarm() {
	const calls: Call[] = [];
	const bindings: Binding[] = [];
	const knobs = {
		/** Capacity announced in create/ready; the sub role must see 131072. */
		capacity: 131_072,
		claimCapacity: undefined as number | undefined,
		catalogCapacity: 262_144,
		outputLimit: undefined as "remaining-context" | undefined,
		outputReserve: 4096,
		connectionTtlMs: 900_000,
		epoch: "epoch-a",
		claimable: true,
		claimBase: `${BASE}/v1`,
		/** Answers one chat POST; defaults to a text answer with usage. */
		chat: ((): Response =>
			json({
				choices: [
					{ index: 0, message: { content: "ok" }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 11, completion_tokens: 3 },
			})) as (
			call: Call,
			signal: AbortSignal | undefined,
		) => Response | Promise<Response>,
		/** Status of GET /v1/agent-connections/:id for the current binding. */
		getStatus: undefined as number | undefined,
	};
	const provider = (capacity: number) => ({
		name: "llm",
		protocol: "openai.chat-completions.v1",
		endpoint: "/v1/chat/completions",
		model: "model-from-catalog",
		contextWindow: {
			maxTokens: capacity,
			outputReserveTokens: knobs.outputReserve,
			safetyMarginTokens: 1024,
			...(knobs.outputLimit ? { outputLimit: knobs.outputLimit } : {}),
		},
	});
	const state = (b: Binding) => ({
		id: b.id,
		profile: SETTINGS.profile,
		agentProfile: "agent-profile-id",
		bootEpoch: b.epoch,
		status: b.status,
		expiresAt: new Date(b.expiresAt).toISOString(),
		providers: [
			{
				...provider(knobs.capacity),
				readiness: "ready",
				claimable: knobs.claimable,
			},
		],
	});
	const claim = (b: Binding) => ({
		...state(b),
		status: "ready",
		providers: [
			{
				...provider(knobs.claimCapacity ?? knobs.capacity),
				baseUrl: knobs.claimBase,
				endpoint: `${knobs.claimBase}/chat/completions`,
				credential: { token: providerToken(b.version) },
				configuration: {
					fields: { baseURL: knobs.claimBase, model: "model-from-catalog" },
				},
			},
		],
	});

	const fetcher = async (
		input: string | URL,
		init: RequestInit = {},
	): Promise<Response> => {
		const url = new URL(String(input));
		const raw = typeof init.body === "string" ? init.body : undefined;
		const call: Call = {
			method: init.method ?? "GET",
			path: url.pathname,
			search: url.search,
			headers: new Headers(init.headers),
			body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
			init: init as Record<string, unknown>,
		};
		calls.push(call);
		init.signal?.throwIfAborted();
		if (call.path === "/v3/agent-profiles") {
			if (!call.search)
				return json({
					contractVersion: "agent-connection.v3",
					catalogRevision: "rev1",
					profiles: [
						{
							id: "chat-a",
							description: "First chat profile",
							selectionPolicy: "default",
							providers: [{ name: "llm", model: "model-a" }],
						},
						{
							id: "chat-b",
							selectionPolicy: "default",
							providers: [
								{ name: "llm", model: "model-b" },
								{ name: "asr", model: "model-asr" },
							],
						},
						{
							id: "explicit",
							selectionPolicy: "explicit-only",
							providers: [{ name: "llm", model: "m" }],
						},
						{
							id: "retired",
							selectionPolicy: "default",
							deprecated: true,
							providers: [{ name: "llm", model: "m" }],
						},
						{
							id: "backchannel-only",
							selectionPolicy: "default",
							providers: [{ name: "backchannel" }],
						},
						{ id: "no-providers", selectionPolicy: "default", providers: [] },
					],
				});
			return json({
				contractVersion: "agent-connection.v3",
				catalogRevision: "rev1",
				requestedProfile: url.searchParams.get("profile"),
				profiles: [
					{
						id: "agent-profile-id",
						providers: [provider(knobs.catalogCapacity)],
					},
				],
			});
		}
		if (
			call.path === "/v1/chat/completions" ||
			call.path === "/v1/chat/completions/"
		)
			return knobs.chat(call, init.signal ?? undefined);
		if (call.path === "/v1/agent-connections" && call.method === "POST") {
			let b = bindings.find(
				(x) => x.client === call.body?.client && !x.released,
			);
			if (!b) {
				b = {
					id: `connection-${bindings.length + 1}`,
					client: String(call.body?.client),
					epoch: knobs.epoch,
					expiresAt: Date.now() + knobs.connectionTtlMs,
					version: 1,
					status: "ready",
					released: false,
				};
				bindings.push(b);
			}
			return json(state(b), 201);
		}
		const match = /^\/v1\/agent-connections\/([^/]+)(?:\/(.+))?$/.exec(
			call.path,
		);
		const b = bindings.find((x) => x.id === match?.[1]);
		if (!match || !b) return json({ error: { code: "not_found" } }, 404);
		const [, , operation] = match;
		if (call.method === "DELETE") {
			b.released = true;
			b.status = "released";
			return new Response(null, { status: 204 });
		}
		if (operation === "renew") {
			b.expiresAt = Date.now() + 900_000;
			b.version++;
			return json(state(b));
		}
		if (operation === "claim") return json(claim(b));
		if (operation === "providers/llm/health") {
			knobs.claimable = true;
			return json({
				name: "llm",
				ready: true,
				acceptingRequests: true,
			});
		}
		if (knobs.getStatus) return json({ error: {} }, knobs.getStatus);
		return json(state(b));
	};

	return {
		fetch: fetcher,
		knobs,
		calls,
		bindings,
		count: (method: string, path: string) =>
			calls.filter((c) => c.method === method && c.path === path).length,
		chats: () => calls.filter((c) => c.path === "/v1/chat/completions"),
	};
}

export type LoggedEvent = InteractLogFields & { name: string };

export function recordingLogger() {
	const events: LoggedEvent[] = [];
	const logger: LoggerPort = {
		event: (name, fields) => void events.push({ name, ...fields }),
	};
	return { logger, events };
}

export const text = (content: string, usage?: unknown) =>
	json({
		choices: [{ index: 0, message: { content }, finish_reason: "stop" }],
		...(usage === undefined ? {} : { usage }),
	});
export { json };
