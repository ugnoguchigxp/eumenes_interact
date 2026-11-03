import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdapterError } from "../../contracts/adapter.ts";
import type {
	AdapterDispatchResult,
	AdapterLaunch,
	AdapterOptions,
	AdapterState,
	AdapterTarget,
	FixedInspection,
	PlatformAdapter,
} from "../../contracts/adapter.ts";
import type {
	InteractEventName,
	InteractLogFields,
} from "../../contracts/common.ts";
import type { RawObservation } from "../../contracts/observation.ts";
import {
	COMMON_ACTIONS,
	type AdapterCommand,
	type CatalogEntry,
} from "../../contracts/operation.ts";
import {
	EXTRACT_PAGE_FUNCTION,
	EXTRACT_TARGET_FUNCTION,
	extractCap,
	parseExtraction,
} from "./extract.ts";
import {
	INSPECT_FOCUSED_FUNCTION,
	INSPECT_LOCATOR_FUNCTION,
	INSPECT_TARGET_FUNCTION,
	parseLocatorInspection,
	parseTargetInspection,
} from "./inspect.ts";
import {
	classifyToolError,
	parseTabList,
	parseToolResult,
	type McpTab,
	type McpToolResult,
	type ParsedToolResult,
} from "./response.ts";
import {
	McpTransportError,
	startMcpSession,
	type McpSession,
	type McpSessionLaunch,
} from "./session.ts";
import {
	commandCall,
	isAllowedTool,
	refOf,
	tabIndexOf,
	webUrl,
	type McpToolName,
} from "./tools.ts";

/**
 * PlatformAdapter over a child `@playwright/mcp` (plan.md §5.2), ported from Eumenes'
 * `mcp-driver.ts`. The only way to reach the child is `callToolNow`, whose names are the closed
 * list of `tools.ts`; `browser_evaluate` is reachable only through the fixed functions of
 * `inspect.ts`. MCP output files hold page text, so every call ends by emptying the output dir.
 *
 * Child flags, appended after the host's own `launch.args` (all documented options of 0.0.83):
 * `--isolated` (profile in memory, no saved browser), `--headless` (when asked; headed is the
 * default), `--output-dir`, `--no-webmcp` (page-registered tools are neither collected nor
 * exposed) and `--config` (a file the adapter writes: the CLI has no option for browser
 * arguments, so `--mute-audio` goes in `browser.launchOptions.args`). Left at their defaults on
 * purpose: `--snapshot-mode full` (action results carry the `### Page` URL/title), `--caps`
 * (core tools only), timeouts and `--blocked-origins` (not a security boundary: destination
 * checks stay with the host).
 */

const TOOL_NAME = "@playwright/mcp";
const OUTPUT_DIR_NAME = "playwright-mcp-output";
const CONFIG_FILE_NAME = "playwright-mcp.config.json";
const CONFIG = { browser: { launchOptions: { args: ["--mute-audio"] } } };

/** Browser start-up and the first tool call, which launches the browser. */
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
/** One tool call (MCP's own navigation timeout is 60 s). */
const DEFAULT_CALL_TIMEOUT_MS = 90_000;

/** Flags (and their `PLAYWRIGHT_MCP_*` variables) that attach the child to a browser that already exists. */
const ATTACH_FLAGS = [
	"extension",
	"cdp-endpoint",
	"endpoint",
	"user-data-dir",
] as const;

/**
 * Codes of failures that are known not to have taken effect and may succeed unchanged on a later
 * attempt. A stale or ambiguous ref, an invalid argument or an unsupported action will not.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
	"action_timeout",
	"navigation_failed",
	"cancelled",
]);

const CATALOG: readonly CatalogEntry[] = COMMON_ACTIONS.map((action) => ({
	action,
	platform: "playwright-mcp",
	supported: action !== "page.scroll" && action !== "page.capture",
	needsTargetRef:
		action === "page.click" ||
		action === "page.hover" ||
		action === "page.fill" ||
		action === "page.select" ||
		action === "browser.selectTab",
	physicalInput: false,
}));

export type PlaywrightMcpAdapterOptions = AdapterOptions & {
	browser: { mode: "isolated"; headless: boolean };
};

/** Test seam: the way the child is started. */
export type PlaywrightMcpDeps = {
	startSession?: (launch: McpSessionLaunch) => McpSession;
};

/** The platform answered with an error (as opposed to a transport or validation failure). */
class ReportedError extends AdapterError {}

export function createPlaywrightMcpAdapter(
	options: PlaywrightMcpAdapterOptions,
	deps: PlaywrightMcpDeps = {},
): PlatformAdapter {
	const startSession = deps.startSession ?? startMcpSession;
	const connectTimeoutMs =
		options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
	const outputDir = join(options.workDir, OUTPUT_DIR_NAME);
	const configPath = join(options.workDir, CONFIG_FILE_NAME);
	let state: AdapterState = "closed";
	let session: McpSession | undefined;
	let serverVersion: string | null = null;
	let opening: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	/** Counts `close()` calls, so an `open` in flight can tell it was closed under it. */
	let closes = 0;
	let queue: Promise<unknown> = Promise.resolve();

	const log = (
		name: InteractEventName,
		fields: Omit<InteractLogFields, "correlationId">,
	) => {
		try {
			options.logger.event(name, {
				correlationId: options.correlationId,
				...fields,
			});
		} catch {
			// A failing logger must not break the adapter.
		}
	};

	/** MCP writes snapshots, console logs and screenshots here; all of it is page content. */
	const clearOutput = async () => {
		try {
			for (const name of await readdir(outputDir))
				await rm(join(outputDir, name), { recursive: true, force: true });
		} catch {
			// Missing directory: nothing to clear.
		}
	};

	/** The child is gone or unusable after `open`: the session is lost, once. */
	const lose = async (child: McpSession, code: string) => {
		if (session !== child) return;
		session = undefined;
		if (state === "open") {
			state = "lost";
			log("adapter.failed", { code });
		}
		await child.close();
		await clearOutput();
	};

	const launchSpec = (): McpSessionLaunch => {
		const { command, args, cwd, env } = options.launch;
		const base: Record<string, string> = {};
		if (process.env.PATH !== undefined) base.PATH = process.env.PATH;
		if (process.env.HOME !== undefined) base.HOME = process.env.HOME;
		return {
			command,
			args: [
				...args,
				"--isolated",
				...(options.browser.headless ? ["--headless"] : []),
				"--output-dir",
				outputDir,
				"--no-webmcp",
				"--config",
				configPath,
			],
			cwd: cwd ?? outputDir,
			env: { ...base, ...env },
		};
	};

	const doOpen = async (signal: AbortSignal) => {
		const begun = Date.now();
		const closesAtStart = closes;
		const closedMeanwhile = () => closes !== closesAtStart;
		state = "opening";
		let child: McpSession | undefined;
		const controller = new AbortController();
		let timedOut = false;
		let aborted = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, connectTimeoutMs);
		const onAbort = () => {
			aborted = true;
			controller.abort();
		};
		try {
			refuseAttachingLaunch(options.launch);
			if (signal.aborted) throw new AdapterError("aborted", false);
			signal.addEventListener("abort", onAbort, { once: true });
			await mkdir(outputDir, { recursive: true, mode: 0o700 });
			await writeFile(configPath, JSON.stringify(CONFIG), { mode: 0o600 });
			await clearOutput();
			// A close during the awaits above found no child to stop; nothing may start after it.
			if (closedMeanwhile()) throw new AdapterError("closed", false);
			const spawned = startSession(launchSpec());
			child = spawned;
			session = spawned;
			spawned.onExit(() => {
				void lose(spawned, "process_exited");
			});
			const request = {
				signal: controller.signal,
				timeoutMs: connectTimeoutMs,
			};
			const init = await spawned.request(
				"initialize",
				{
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "eumenes-interact", version: "1" },
				},
				request,
			);
			serverVersion = versionOf(init);
			spawned.notify("notifications/initialized");
			// The first tool call launches the browser.
			const raw = (await spawned.request(
				"tools/call",
				{ name: "browser_tabs", arguments: { action: "list" } },
				request,
			)) as McpToolResult;
			const parsed = parseToolResult(raw);
			if (parsed.isError || !parseTabList(parsed.result))
				throw new AdapterError("mcp_unavailable", false);
			if (closedMeanwhile()) throw new AdapterError("closed", false);
			if (session !== spawned) throw new AdapterError("process_exited", false);
			state = "open";
			log("adapter.opened", { durationMs: Date.now() - begun });
		} catch (error) {
			const code =
				error instanceof AdapterError
					? error.code
					: timedOut
						? "connect_timeout"
						: aborted
							? "aborted"
							: error instanceof McpTransportError && error.reason === "exited"
								? "process_exited"
								: "mcp_unavailable";
			if (child && session === child) {
				session = undefined;
				await child.close();
			}
			state = "closed";
			log("adapter.failed", { code, durationMs: Date.now() - begun });
			throw new AdapterError(code, false);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			await clearOutput();
		}
	};

	const serial = <T>(
		signal: AbortSignal | undefined,
		run: () => Promise<T>,
	): Promise<T> => {
		const next = queue.then(() => {
			if (signal?.aborted) throw new AdapterError("cancelled", false);
			return run();
		});
		queue = next.catch(() => {});
		return next;
	};

	/** The single door to the child: names outside the closed list cannot be called. */
	const callToolNow = async (
		name: McpToolName,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		readSnapshotFile = false,
	): Promise<ParsedToolResult & { snapshotText?: string }> => {
		if (!isAllowedTool(name)) throw new AdapterError("tool_not_allowed", false);
		const child = session;
		if (!child || state !== "open") throw new AdapterError("not_open", false);
		try {
			let raw: McpToolResult;
			try {
				raw = (await child.request(
					"tools/call",
					{ name, arguments: args },
					{ signal, timeoutMs: callTimeoutMs },
				)) as McpToolResult;
			} catch (error) {
				throw fromTransport(error);
			}
			const parsed = parseToolResult(raw);
			if (parsed.isError) {
				const failure = classifyToolError(parsed.error, name);
				if (failure.code === "browser_closed")
					void lose(child, "browser_closed");
				throw new ReportedError(failure.code, failure.dispatched);
			}
			const snapshotText =
				readSnapshotFile && parsed.snapshot?.kind === "file"
					? await readOutputFile(outputDir, parsed.snapshot.name)
					: undefined;
			return { ...parsed, snapshotText };
		} catch (error) {
			if (
				error instanceof AdapterError &&
				(error.code === "process_exited" || error.code === "mcp_unavailable")
			)
				void lose(child, error.code);
			throw error;
		} finally {
			await clearOutput();
		}
	};
	const callTool = (
		name: McpToolName,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		readSnapshotFile = false,
	) => serial(signal, () => callToolNow(name, args, signal, readSnapshotFile));

	const tabsCall = async (
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpTab[]> => {
		const tabs = parseTabList(
			(await callTool("browser_tabs", args, signal)).result,
		);
		if (!tabs) throw new AdapterError("mcp_response_unrecognized", true);
		return tabs;
	};

	/** Reads never reach the page, so whatever goes wrong in them is not dispatched. */
	const readOnly = async <T>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			throw new AdapterError(
				error instanceof AdapterError ? error.code : "mcp_unavailable",
				false,
			);
		}
	};

	/** A read with its outcome logged (counts and codes only, never the content). */
	const loggedRead = <T>(
		run: () => Promise<T>,
		count?: (value: T) => number,
	): Promise<T> => {
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
	};

	const runDispatch = async (
		command: AdapterCommand,
		signal: AbortSignal,
	): Promise<AdapterDispatchResult> => {
		const refused = (code: string): AdapterDispatchResult => ({
			status: "not_dispatched",
			code,
			retryable: RETRYABLE_CODES.has(code),
		});
		let call: ReturnType<typeof commandCall>;
		try {
			call = commandCall(command);
		} catch (error) {
			return refused(
				error instanceof AdapterError ? error.code : "unsupported",
			);
		}
		try {
			const parsed = await callTool(call[0], call[1], signal);
			// The action succeeded: a page that cannot be named leaves url and title out.
			const page =
				parsed.page ??
				(await tabsCall({ action: "list" })
					.then((tabs) => tabs.find((tab) => tab.current))
					.catch(() => undefined));
			return {
				status: "confirmed",
				retryable: false,
				...(page ? { url: page.url } : {}),
				...(page?.title ? { title: page.title } : {}),
			};
		} catch (error) {
			const failure =
				error instanceof AdapterError
					? error
					: new AdapterError("mcp_unavailable", true);
			if (failure.dispatched)
				return {
					status: "indeterminate",
					code: failure.code,
					retryable: false,
				};
			if (failure instanceof ReportedError)
				return {
					status: "failed",
					code: failure.code,
					retryable: RETRYABLE_CODES.has(failure.code),
				};
			return refused(failure.code);
		}
	};

	const inspectCall = (args: Record<string, unknown>, signal: AbortSignal) =>
		readOnly(
			async () => (await callTool("browser_evaluate", args, signal)).result,
		);

	return {
		platform: "playwright-mcp",
		toolInfo: () => ({ name: TOOL_NAME, version: serverVersion }),
		catalog: () => CATALOG,
		open(signal) {
			if (state === "open") return Promise.resolve();
			opening ??= doOpen(signal).finally(() => {
				opening = undefined;
			});
			return opening;
		},
		close() {
			closes++;
			closing ??= (async () => {
				const child = session;
				const wasOpen = state !== "closed";
				session = undefined;
				state = "closed";
				if (child) await child.close();
				await clearOutput();
				if (wasOpen) log("adapter.closed", {});
			})().finally(() => {
				closing = undefined;
			});
			return closing;
		},
		state: () => state,
		listTargets: (signal) =>
			readOnly(async () =>
				toTargets(await tabsCall({ action: "list" }, signal)),
			),
		async selectTarget(targetRef, signal) {
			const index = tabIndexOf(targetRef);
			return toTargets(await tabsCall({ action: "select", index }, signal));
		},
		async newTarget(url, signal) {
			return toTargets(
				await tabsCall({ action: "new", url: webUrl(url) }, signal),
			);
		},
		observe: (signal) =>
			loggedRead(async (): Promise<RawObservation> => {
				const parsed = await callTool("browser_snapshot", {}, signal, true);
				const body =
					parsed.snapshot?.kind === "inline"
						? parsed.snapshot.text
						: parsed.snapshotText;
				if (body === undefined)
					throw new AdapterError("mcp_response_unrecognized", false);
				const { url, title } = parsed.page ?? {};
				return {
					body,
					...(url !== undefined ? { url } : {}),
					...(title !== undefined ? { title } : {}),
					truncated: false,
					missing: [
						...(url === undefined ? (["url"] as const) : []),
						...(title === undefined ? (["title"] as const) : []),
					],
				};
			}),
		extract: (targetRef, maxChars, signal) =>
			loggedRead(
				async () => {
					const cap = extractCap(maxChars);
					const args =
						targetRef === null
							? { function: EXTRACT_PAGE_FUNCTION }
							: {
									function: EXTRACT_TARGET_FUNCTION,
									target: refOf(targetRef),
									element: "extracted element",
								};
					const { result } = await callTool("browser_evaluate", args, signal);
					return parseExtraction(result, targetRef !== null, cap);
				},
				(content) => content.charCount,
			),
		async dispatch(command, signal) {
			const started = Date.now();
			const result = await runDispatch(command, signal);
			if (result.status === "confirmed")
				log("adapter.dispatched", { durationMs: Date.now() - started });
			else
				log("adapter.failed", {
					...(result.code !== undefined ? { code: result.code } : {}),
					durationMs: Date.now() - started,
				});
			return result;
		},
		async inspect(kind: FixedInspection, targetRef, signal) {
			if (signal.aborted) throw new AdapterError("cancelled", false);
			switch (kind) {
				case "inspectTarget":
					return parseTargetInspection(
						await inspectCall(
							{
								function: INSPECT_TARGET_FUNCTION,
								target: refOf(targetRef),
								element: "inspected element",
							},
							signal,
						),
					);
				case "inspectLocator":
					return parseLocatorInspection(
						await inspectCall(
							{
								function: INSPECT_LOCATOR_FUNCTION,
								target: refOf(targetRef),
								element: "inspected element",
							},
							signal,
						),
					);
				case "inspectFocused":
					return parseTargetInspection(
						await inspectCall({ function: INSPECT_FOCUSED_FUNCTION }, signal),
					);
				default:
					throw new AdapterError("unsupported", false);
			}
		},
	};
}

/** The adapter only ever drives its own isolated browser (plan.md §5.2). */
function refuseAttachingLaunch(launch: AdapterLaunch) {
	for (const flag of ATTACH_FLAGS) {
		const variable = `PLAYWRIGHT_MCP_${flag.toUpperCase().replaceAll("-", "_")}`;
		if (
			launch.args.some(
				(arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`),
			) ||
			(launch.env !== undefined && variable in launch.env)
		)
			throw new AdapterError("launch_not_isolated", false);
	}
}

function versionOf(initialize: unknown): string | null {
	const version = (initialize as { serverInfo?: { version?: unknown } } | null)
		?.serverInfo?.version;
	return typeof version === "string" && version !== "" && version.length <= 64
		? version
		: null;
}

function toTargets(tabs: McpTab[]): AdapterTarget[] {
	return tabs.map((tab) => ({
		targetRef: String(tab.index),
		kind: "tab",
		current: tab.current,
		url: tab.url,
		title: tab.title,
	}));
}

/** Links are relative to MCP's workspace or absolute; only the base name is looked up. */
async function readOutputFile(directory: string, name: string) {
	try {
		return await readFile(join(directory, name), "utf8");
	} catch {
		throw new AdapterError("snapshot_file_missing", false);
	}
}

function fromTransport(error: unknown): AdapterError {
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
