/**
 * Small guards of the LARM client. Ported from Eumenes `api/domains/larm/service/guards.ts`,
 * `infrastructure/bounded-read.ts` and `infrastructure/error-code.ts`.
 *
 * Errors carry a fixed code and nothing else: no URL, header, token or response text ever
 * reaches a message.
 */

export class LarmError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

/** A generation POST LARM answered with a non-2xx status: the request was refused, not processed. */
export class LarmRejection extends LarmError {
	constructor(
		readonly status: number,
		/** The provider's machine-readable error code, when it sent one. */
		readonly providerCode?: string,
	) {
		super(`larm_inference_${status}`);
	}
}

export type Fetcher = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new LarmError("larm_invalid_contract");
	return value as Record<string, unknown>;
}

export function string(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 4096)
		throw new LarmError("larm_invalid_contract");
	return value;
}

export const records = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value) ? value.map(record) : [];

export const wait = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		signal.throwIfAborted();
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal.addEventListener("abort", abort, { once: true });
	});

export async function untilAborted<T>(
	task: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	signal.throwIfAborted();
	let abort: () => void = () => {};
	try {
		return await Promise.race([
			task,
			new Promise<never>((_, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

/** Reads a whole body under a byte limit; a failure cancels the stream. */
export async function readBounded(
	body: ReadableStream<Uint8Array> | null | undefined,
	limit: number,
	tooLarge: string,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	if (!body) throw new LarmError("larm_empty_response");
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			signal?.throwIfAborted();
			const { value, done } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new LarmError(tooLarge);
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function readJson(
	response: Response,
	signal?: AbortSignal,
): Promise<unknown> {
	const bytes = await readBounded(
		response.body,
		1_000_000,
		"larm_response_too_large",
		signal,
	);
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new LarmError("larm_invalid_json");
	}
}

/** LARM control and providers live on the local host or a private LAN; never on a public address. */
export function localEndpoint(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new LarmError("larm_base_url_invalid");
	}
	if (!(
		["http:", "https:"].includes(url.protocol) &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash &&
		(url.hostname === "localhost" ||
			// A `.local` name is allowed; providers are further pinned to the LARM host.
			url.hostname.endsWith(".local") ||
			(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) &&
				url.hostname.split(".").every((part) => Number(part) <= 255) &&
				/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
					url.hostname,
				)))
	))
		throw new LarmError("larm_nonlocal_endpoint");
	return url;
}

/** A provider may receive its credential only at the LARM host. */
export function providerEndpoint(value: string, larmBase: URL): URL {
	const url = localEndpoint(value);
	if (url.hostname.toLowerCase() !== larmBase.hostname.toLowerCase())
		throw new LarmError("larm_provider_host_mismatch");
	return url;
}

const networkCodes = new Set([
	"ConnectionRefused",
	"ConnectionClosed",
	"ConnectionReset",
	"FailedToOpenSocket",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
]);

const networkMessages = [
	"fetch failed",
	"Unable to connect",
	"The socket connection was closed unexpectedly",
	"terminated",
];

/** A transport failure of fetch. Bugs that throw TypeError are not. */
export function isNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as { code?: unknown }).code;
	const causeCode = (error.cause as { code?: unknown } | undefined)?.code;
	return (
		(typeof code === "string" && networkCodes.has(code)) ||
		(typeof causeCode === "string" && networkCodes.has(causeCode)) ||
		(error instanceof TypeError &&
			networkMessages.some((m) => error.message.startsWith(m)))
	);
}
