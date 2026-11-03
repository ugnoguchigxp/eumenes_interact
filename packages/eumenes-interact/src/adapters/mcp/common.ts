import { AdapterError } from "../../contracts/adapter.ts";
import type { AdapterLaunch, AdapterOptions } from "../../contracts/adapter.ts";
import type {
	InteractEventName,
	InteractLogFields,
} from "../../contracts/common.ts";
import { McpTransportError } from "./session.ts";

/**
 * Pieces the MCP-based adapters share: the raw tool result type,
 * the mapping of transport failures, ref and URL validation and the launch guard.
 */

export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export type McpToolResult = { content?: McpContent[]; isError?: boolean };

/** Transport failures keep the real dispatch state: a request that was written may have been acted on. */
export function fromTransport(error: unknown): AdapterError {
	if (!(error instanceof McpTransportError))
		return new AdapterError("mcp_unavailable", true);
	switch (error.reason) {
		case "timeout":
			return new AdapterError("call_timeout", error.dispatched);
		case "aborted":
			return new AdapterError("cancelled", error.dispatched);
		case "exited":
			return new AdapterError("process_exited", error.dispatched);
		case "output_limit":
			return new AdapterError("mcp_unavailable", true);
		case "rpc_error":
			// -32602 invalid params / -32601 unknown method: rejected before any tool ran.
			return new AdapterError(
				"mcp_protocol_error",
				error.rpcCode !== -32602 && error.rpcCode !== -32601,
			);
	}
}

/** The server's version from the `initialize` result, null when it gives none. */
export function versionOf(initialize: unknown): string | null {
	const version = (initialize as { serverInfo?: { version?: unknown } } | null)
		?.serverInfo?.version;
	return typeof version === "string" && version !== "" && version.length <= 64
		? version
		: null;
}

/** Element refs from `[ref=eN]` (optionally frame-prefixed `f1e3`). Anything else would be a selector. */
const REF = /^(?:f\d+)?e\d+$/;

/** Validation failures happen before anything is sent: `dispatched` is false. */
export function refOf(ref: string | undefined | null): string {
	if (typeof ref !== "string" || !REF.test(ref))
		throw new AdapterError("invalid_ref", false);
	return ref;
}

/** Defence in depth: the host decides destinations; the adapter never sends other schemes. */
export function webUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AdapterError("invalid_url", false);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		throw new AdapterError("invalid_url", false);
	return url;
}

/**
 * Refuses a host launch that would change what the adapter owns (plan.md §5.2): attach to a browser
 * that already exists, reuse a profile, or pick the session. `flags` are long names without `--`;
 * `variables` are environment variable names.
 */
export function refuseLaunchOptions(
	launch: AdapterLaunch,
	rules: { flags: readonly string[]; variables: readonly string[] },
) {
	const flagged = rules.flags.some((flag) =>
		launch.args.some(
			(arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`),
		),
	);
	const varied = rules.variables.some(
		(name) => launch.env !== undefined && name in launch.env,
	);
	if (flagged || varied) throw new AdapterError("launch_not_isolated", false);
}

export type Log = (
	name: InteractEventName,
	fields: Omit<InteractLogFields, "correlationId">,
) => void;

/** The adapter's logger: fixed event names and fields only; a logger that throws cannot break the adapter. */
export function createLog(options: AdapterOptions): Log {
	return (name, fields) => {
		try {
			options.logger.event(name, {
				correlationId: options.correlationId,
				...fields,
			});
		} catch {
			// A failing logger must not break the adapter.
		}
	};
}

/** Reads never reach the page, so whatever goes wrong in them is not dispatched. */
export async function readOnly<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		throw new AdapterError(
			error instanceof AdapterError ? error.code : "mcp_unavailable",
			false,
		);
	}
}

/** A read with its outcome logged (counts and codes, never the content). */
export function loggedRead<T>(
	log: Log,
	run: () => Promise<T>,
	count?: (value: T) => number,
): Promise<T> {
	const started = Date.now();
	return readOnly(run).then(
		(value) => {
			log("adapter.observed", {
				durationMs: Date.now() - started,
				...(count ? { count: count(value) } : {}),
			});
			return value;
		},
		(error: AdapterError) => {
			log("adapter.failed", {
				code: error.code,
				durationMs: Date.now() - started,
			});
			throw error;
		},
	);
}
