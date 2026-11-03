import { type Fetcher, LarmError } from "./guards.ts";

/** Budget of a control request: POSTs (create, claim, renew) may wait on LARM this long. */
const CONTROL_TIMEOUT_MS = 15_000;
/** Read-only status checks made for a caller must answer quickly. */
const STATUS_CHECK_TIMEOUT_MS = 3_000;

/** A control-plane request: path, init, accepted statuses. Anything else throws `larm_control_<status>`. */
export type Control = (
	path: string,
	init: RequestInit,
	accepted: number[],
) => Promise<Response>;

/**
 * Bun owns HTTP compression and decompression: ask for gzip responses and, for generation, send gzip
 * bodies. Control requests are never compressed (LARM answers 400 to a gzip body there).
 * Ported from Eumenes `gzip-fetch.ts`.
 */
export function gzipFetch(request: Fetcher, compressRequest: boolean): Fetcher {
	return (input, init = {}) => {
		init.signal?.throwIfAborted();
		const headers = new Headers(init.headers);
		headers.set("Accept-Encoding", "gzip");
		const options = {
			...init,
			headers,
			compress: compressRequest && init.body != null ? "gzip" : false,
			decompress: true,
		};
		return request(input, options);
	};
}

/**
 * The authenticated control-plane request of one session; it never leaves the control origin.
 * Ported from Eumenes `control.ts`.
 */
export function createControl({
	base,
	token,
	request,
	lifetime,
}: {
	base: URL;
	token: string;
	request: Fetcher;
	/** Aborted when the session closes: every control request ends with it. */
	lifetime: AbortSignal;
}): Control {
	return async (path, init, accepted) => {
		const url = new URL(path, base);
		if (url.origin !== base.origin)
			throw new LarmError("larm_control_origin_mismatch");
		const response = await request(url, {
			...init,
			headers: { Authorization: `Bearer ${token}`, ...init.headers },
			redirect: "error",
			signal:
				init.method === "DELETE"
					? AbortSignal.timeout(CONTROL_TIMEOUT_MS)
					: AbortSignal.any([
							lifetime,
							AbortSignal.timeout(
								(!init.method || init.method === "GET") && init.signal
									? STATUS_CHECK_TIMEOUT_MS
									: CONTROL_TIMEOUT_MS,
							),
							...(init.signal ? [init.signal] : []),
						]),
		});
		if (!accepted.includes(response.status)) {
			await response.body?.cancel().catch(() => {});
			throw new LarmError(`larm_control_${response.status}`);
		}
		return response;
	};
}
