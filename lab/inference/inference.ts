import { createHash } from "node:crypto";
import type {
	InferenceOutcome,
	InferencePort,
	InferenceRequest,
	InteractEventName,
	InteractLogFields,
	LoggerPort,
} from "eumenes-interact";
import { chatBody, providerErrorCode, readChat } from "./chat.ts";
import { createConnection } from "./connection.ts";
import { createControl, gzipFetch } from "./control.ts";
import {
	type Fetcher,
	LarmError,
	LarmRejection,
	isNetworkError,
	localEndpoint,
	untilAborted,
} from "./guards.ts";

export type LarmSettings = { baseUrl: string; profile: string };

/** Fields are a correlation id, a fixed code and a duration, never text or a credential. */
type InferenceEvent = Extract<InteractEventName, `inference.${string}`>;

/** A generation that stays silent this long after the request was sent is cut (Eumenes `providerRequest`). */
const GENERATION_GUARD_MS = 300_000;

/** Why a call ended without an answer: the code recorded for it. */
function failureCode(
	error: unknown,
	signal: AbortSignal,
	phase: "control" | "generation",
): string {
	if (signal.aborted) {
		const reason: unknown = signal.reason;
		if (reason instanceof LarmError) return reason.code;
		return reason instanceof DOMException && reason.name === "TimeoutError"
			? "deadline"
			: "aborted";
	}
	if (error instanceof LarmRejection) return `http_${error.status}`;
	if (error instanceof LarmError) return error.code;
	if (error instanceof DOMException && error.name === "TimeoutError")
		return "deadline";
	// The result of a lost generation is unknown; it is never sent again.
	if (isNetworkError(error))
		return phase === "generation" ? "transport_lost" : "larm_connection_failed";
	return "larm_failed";
}

/**
 * The host's inference port over one LARM chat session (plan.md §4, §10.5): Eumenes' LARM path of a
 * sub-role agent session (`sessionRole: "subagent"`), reduced to the plain chat Arm 0 needs.
 * The token comes from the caller only and is used for the control plane; it is never logged,
 * stored or put in an error.
 */
export function createLarmInference(o: {
	settings: LarmSettings;
	token: string;
	clientId: string;
	logger: LoggerPort;
	correlationId: string;
	fetch?: Fetcher;
}): InferencePort & {
	close(): Promise<void>;
	describe(): { profile: string; model: string | null };
} {
	const token = o.token.trim();
	const profile = o.settings.profile.trim();
	if (!token) throw new LarmError("larm_unconfigured");
	if (!profile) throw new LarmError("larm_profile_missing");
	if (!o.clientId) throw new LarmError("larm_client_missing");
	const base = localEndpoint(o.settings.baseUrl.trim());
	const lifetime = new AbortController();
	const send = o.fetch ?? fetch;
	const generate = gzipFetch(send, true);
	// Opaque and stable per session, so a reconnection reuses LARM's input cache.
	const promptCacheKey = createHash("sha256")
		.update(JSON.stringify([o.clientId, "prompt-cache"]))
		.digest("hex");
	const emit = (
		name: InferenceEvent,
		fields: Omit<InteractLogFields, "correlationId">,
	) => {
		try {
			o.logger.event(name, {
				correlationId: o.correlationId,
				...fields,
			});
		} catch {
			// Diagnostics must never change the inference result.
		}
	};
	const connection = createConnection({
		base,
		profile,
		client: o.clientId,
		control: createControl({
			base,
			token,
			request: gzipFetch(send, false),
			lifetime: lifetime.signal,
		}),
		lifetime: lifetime.signal,
		log: (name, fields) => emit(`inference.${name}`, fields),
	});

	/** One call at a time infers on the session's connection. */
	let tail: Promise<void> = Promise.resolve();
	async function exclusive<T>(
		signal: AbortSignal,
		job: () => Promise<T>,
	): Promise<T> {
		const previous = tail;
		let finish!: () => void;
		tail = new Promise<void>((resolve) => {
			finish = resolve;
		});
		try {
			await untilAborted(previous, signal);
			return await job();
		} finally {
			// A cancelled queued call must not let a later call overtake the active one.
			void previous.finally(finish);
		}
	}

	async function infer(
		request: InferenceRequest,
		scoped: AbortSignal,
		sent: { at?: number },
	): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			const lease = await connection.connect(scoped);
			const { provider } = lease;
			const endpoint = new URL(provider.baseUrl.replace(/\/$/, "") + "/");
			const url = provider.endpoint
				? new URL(provider.endpoint)
				: new URL("chat/completions", endpoint);
			if (url.origin !== endpoint.origin)
				throw new LarmError("larm_endpoint_mismatch");
			scoped.throwIfAborted();
			sent.at = performance.now();
			try {
				const response = await generate(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						Authorization: `Bearer ${provider.token}`,
					},
					body: JSON.stringify(
						chatBody(
							provider,
							request.messages,
							request.maxOutputTokens,
							promptCacheKey,
						),
					),
					redirect: "error",
					signal: AbortSignal.any([
						scoped,
						AbortSignal.timeout(GENERATION_GUARD_MS),
					]),
				});
				if (response.ok) return response;
				throw new LarmRejection(
					response.status,
					await providerErrorCode(response, scoped),
				);
			} catch (error) {
				// Only an explicit refusal LARM made before inference began may be sent once more, on a
				// fresh connection. A transport loss leaves the result unknown and is never resent.
				if (scoped.aborted || !(error instanceof LarmRejection)) throw error;
				let unusable =
					error.status === 409 &&
					error.providerCode === "connection_idle_released";
				if (error.status === 401 && error.providerCode === "unauthorized") {
					try {
						unusable = await connection.isReleased(lease, scoped);
					} catch {
						scoped.throwIfAborted();
					}
				}
				if (!unusable) throw error;
				connection.discard(lease);
				sent.at = undefined;
				if (attempt > 0) throw error;
			}
		}
	}

	let closing: Promise<void> | undefined;
	return {
		async complete(request) {
			const started = performance.now();
			const sent: { at?: number } = {};
			const scoped = AbortSignal.any([request.signal, lifetime.signal]);
			const finish = (outcome: InferenceOutcome): InferenceOutcome => {
				emit(
					outcome.kind === "text" ? "inference.completed" : "inference.failed",
					{
						code: outcome.kind === "text" ? "text" : outcome.code,
						durationMs: outcome.latencyMs,
					},
				);
				return outcome;
			};
			const failed = (
				error: unknown,
				phase: "control" | "generation",
			): InferenceOutcome =>
				finish({
					kind: "error",
					code: failureCode(error, scoped, phase),
					usage: { inputTokens: null, outputTokens: null },
					latencyMs: Math.round(performance.now() - (sent.at ?? started)),
				});
			// Eumenes' LARM path enforces a schema with `response_format: json_schema` (strict); that is
			// not ported yet, so the schema is refused rather than ignored.
			if (request.outputSchema)
				return finish({
					kind: "error",
					code: "output_schema_unsupported",
					usage: { inputTokens: null, outputTokens: null },
					latencyMs: 0,
				});
			try {
				return await exclusive(scoped, async () => {
					let response: Response;
					try {
						response = await infer(request, scoped, sent);
					} catch (error) {
						return failed(
							error,
							sent.at === undefined ? "control" : "generation",
						);
					}
					try {
						const result = await readChat(response, scoped);
						return finish({
							...result,
							latencyMs: Math.round(performance.now() - (sent.at ?? started)),
						});
					} catch (error) {
						return failed(error, "generation");
					}
				});
			} catch (error) {
				// Cancelled while waiting for an earlier call.
				return failed(error, "control");
			}
		},
		async close() {
			closing ??= (async () => {
				lifetime.abort(new LarmError("larm_closed"));
				// Calls in flight end with the lifetime; the connection is released after them.
				await tail.catch(() => {});
				try {
					await connection.close();
				} catch {
					emit("inference.failed", { code: "larm_release_unconfirmed" });
				}
			})();
			return closing;
		},
		describe: () => ({ profile, model: connection.model() }),
	};
}
