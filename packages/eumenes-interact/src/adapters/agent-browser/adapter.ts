import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdapterError } from "../../contracts/adapter.ts";
import type {
	AdapterDispatchResult,
	AdapterOptions,
	AdapterState,
	AdapterTarget,
	FixedInspection,
	PlatformAdapter,
} from "../../contracts/adapter.ts";
import type { RawObservation } from "../../contracts/observation.ts";
import {
	COMMON_ACTIONS,
	type AdapterCommand,
	type CatalogEntry,
	type CommonActionId,
} from "../../contracts/operation.ts";
import {
	createLog,
	fromTransport,
	loggedRead,
	readOnly,
	refOf,
	refuseLaunchOptions,
	textOf,
	versionOf,
	webUrl,
	type McpToolResult,
} from "../mcp/common.ts";
import {
	EXTRACT_PAGE_FUNCTION,
	EXTRACT_TARGET_FUNCTION,
	extractCap,
	extractionFromText,
	parseExtraction,
} from "../mcp/extract.ts";
import {
	INSPECT_FOCUSED_FUNCTION,
	INSPECT_LOCATOR_FUNCTION,
	INSPECT_TARGET_FUNCTION,
	parseLocatorInspection,
	parseTargetInspection,
} from "../mcp/inspect.ts";
import {
	fixedScript,
	locateScript,
	parseBox,
	parseLocated,
	type FixedScript,
} from "./locate.ts";
import { McpTransportError, startMcpSession } from "../mcp/session.ts";
import type { McpSession, McpSessionLaunch } from "../mcp/session.ts";
import {
	classifyToolError,
	evalResult,
	parseTabs,
	parseTitle,
	parseUrl,
	type AbTab,
} from "./response.ts";
import {
	CORE_TABS_TOOLS,
	commandCalls,
	isAllowedTool,
	OPEN_TIMEOUT_MS,
	selectorOf,
	tabIdOf,
	type AbToolName,
} from "./tools.ts";

/**
 * PlatformAdapter over a child `agent-browser mcp` (plan.md §5.2, S3), reached through the shared
 * stdio JSON-RPC client. The host supplies the executable and the tool profiles
 * (`mcp --tools core,tabs`); the only way to reach the child is `callToolNow`, whose names are the
 * closed list of `tools.ts`. `agent_browser_eval` runs only the fixed scripts below.
 *
 * What the adapter owns, through the child's environment (the host's values cannot replace them):
 * `AGENT_BROWSER_SESSION` (unique per adapter, so sessions never share a browser),
 * `AGENT_BROWSER_CONFIG` (a file of its own, so no user or project config applies: no profile, no
 * attached browser) and `AGENT_BROWSER_ARGS=--mute-audio`. Headed/headless and `webmcp:false` go
 * with the call that launches the browser: nothing launches before the first `open`.
 *
 * Differences from Playwright MCP, on purpose and visible in the catalog and in what `inspect`
 * and `extract` accept: no hover, no `textGone` wait, scroll is supported; no tool runs a function
 * on an element, so a ref is found again by its box (`locate.ts`, needs `get_box`, i.e. a wider
 * `--tools` profile such as `all`), and an element that cannot be found again is unsupported.
 */

const TOOL_NAME = "agent-browser";
const CONFIG_FILE_NAME = "agent-browser.config.json";
const CWD_DIR_NAME = "agent-browser";
const MUTE_AUDIO = "--mute-audio";

const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 90_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
/** How long `close` lets a call in flight finish before it sends the browser close. */
const DEFAULT_CLOSE_WAIT_MS = 3000;
const MAX_TOOL_PAGES = 20;

/** Flags that attach to a browser that exists, reuse a profile or state, or pick what the adapter owns. */
const OWNED_FLAGS = [
	"cdp",
	"auto-connect",
	"profile",
	"state",
	"restore",
	"session-name",
	"provider",
	"extension",
	"session",
	"config",
] as const;
const OWNED_VARIABLES = [
	"AGENT_BROWSER_CDP",
	"AGENT_BROWSER_AUTO_CONNECT",
	"AGENT_BROWSER_PROFILE",
	"AGENT_BROWSER_STATE",
	"AGENT_BROWSER_RESTORE",
	"AGENT_BROWSER_SESSION_NAME",
	"AGENT_BROWSER_PROVIDER",
	"AGENT_BROWSER_EXTENSIONS",
	"AGENT_BROWSER_SESSION",
	"AGENT_BROWSER_CONFIG",
] as const;
/** Raw Chrome arguments that would select a profile or open a debugging port. */
const UNSAFE_BROWSER_ARGS = /user-data-dir|remote-debugging/i;

/** The scripts without inputs. The tool may quote what a script returns, so they return JSON text. */
const EXTRACT_SCRIPT = fixedScript(
	`JSON.stringify((${EXTRACT_PAGE_FUNCTION})())`,
);
const INSPECT_FOCUSED_SCRIPT = fixedScript(
	`JSON.stringify((${INSPECT_FOCUSED_FUNCTION})())`,
);
export { EXTRACT_SCRIPT, INSPECT_FOCUSED_SCRIPT };

/** Failures known not to have taken effect that may succeed unchanged later. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
	"action_timeout",
	"navigation_failed",
	"cancelled",
]);

/** The tools each common action needs; an action the server does not offer is unsupported. */
const ACTION_TOOLS: Partial<Record<CommonActionId, readonly AbToolName[]>> = {
	"page.observe": ["agent_browser_snapshot"],
	"page.click": ["agent_browser_click"],
	"page.fill": ["agent_browser_fill", "agent_browser_press"],
	"page.select": ["agent_browser_select"],
	"page.press": ["agent_browser_press"],
	"page.scroll": ["agent_browser_scroll"],
	"page.wait": ["agent_browser_wait_ms", "agent_browser_wait_for_text"],
	"page.extract": ["agent_browser_eval"],
	"browser.navigate": ["agent_browser_open"],
	"browser.back": ["agent_browser_back"],
	"browser.tabs": ["agent_browser_tab_list"],
	"browser.selectTab": ["agent_browser_tab_switch", "agent_browser_tab_list"],
};
const NEEDS_TARGET_REF: ReadonlySet<string> = new Set([
	"page.click",
	"page.fill",
	"page.select",
	"browser.selectTab",
]);

export type AgentBrowserAdapterOptions = AdapterOptions & {
	browser: { headless: boolean };
	/** Snapshot options; the default keeps link URLs (they are needed to choose links). */
	snapshot?: {
		includeUrls?: boolean;
		interactive?: boolean;
		compact?: boolean;
	};
};

/** Test seam. */
export type AgentBrowserDeps = {
	startSession?: (launch: McpSessionLaunch) => McpSession;
	sessionId?: () => string;
	closeTimeoutMs?: number;
	closeWaitMs?: number;
};

/** The platform answered with an error (as opposed to a transport or validation failure). */
class ReportedError extends AdapterError {}

const BLANK_PAGE = "about:blank";

/** How long a click, key or submit lets the page settle before its url is read. */
const SETTLE_TIMEOUT_MS = 5000;

/** The commands that can navigate: the url is read only after the page has settled. */
const settles = (command: AdapterCommand) =>
	command.action === "page.click" ||
	command.action === "page.press" ||
	(command.action === "page.fill" && command.submit);

/**
 * Whether the page the tab is on is the one a navigation asked for: scheme and host in lower case,
 * default port dropped, same path and query. An empty path and `/` are the same; a fragment is ignored.
 */
function sameNavigation(requested: string, actual: string): boolean {
	try {
		const a = new URL(requested);
		const b = new URL(actual);
		return (
			a.protocol === b.protocol &&
			a.host === b.host &&
			a.pathname === b.pathname &&
			a.search === b.search
		);
	} catch {
		return false;
	}
}

const newSessionId = () =>
	`ei-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

export function createAgentBrowserAdapter(
	options: AgentBrowserAdapterOptions,
	deps: AgentBrowserDeps = {},
): PlatformAdapter {
	const startSession = deps.startSession ?? startMcpSession;
	const closeTimeoutMs = deps.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
	const closeWaitMs = deps.closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS;
	const connectTimeoutMs =
		options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
	const snapshotArgs = {
		includeUrls: true,
		...options.snapshot,
	};
	const cwd = join(options.workDir, CWD_DIR_NAME);
	const configPath = join(options.workDir, CONFIG_FILE_NAME);
	const sessionId = (deps.sessionId ?? newSessionId)();
	const log = createLog(options);
	let state: AdapterState = "closed";
	let session: McpSession | undefined;
	let serverVersion: string | null = null;
	/** Tool names the server offers (read at `open`); before that, what `core,tabs` offers. */
	let available: ReadonlySet<string> = CORE_TABS_TOOLS;
	/** True once a call that launches the browser has been sent: `close` then closes the browser too. */
	let browserStarted = false;
	let opening: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let closes = 0;
	let queue: Promise<unknown> = Promise.resolve();

	const has = (tool: AbToolName) => available.has(tool);

	const lose = async (child: McpSession, code: string) => {
		if (session !== child) return;
		session = undefined;
		if (state === "open") {
			state = "lost";
			log("adapter.failed", { code });
		}
		await child.close();
	};

	const launchSpec = (): McpSessionLaunch => {
		const { command, args, env } = options.launch;
		const base: Record<string, string> = {};
		if (process.env.PATH !== undefined) base.PATH = process.env.PATH;
		if (process.env.HOME !== undefined) base.HOME = process.env.HOME;
		const hostArgs = env?.AGENT_BROWSER_ARGS;
		return {
			command,
			args: [...args],
			cwd,
			env: {
				...base,
				...env,
				AGENT_BROWSER_SESSION: sessionId,
				AGENT_BROWSER_CONFIG: configPath,
				AGENT_BROWSER_ARGS:
					hostArgs === undefined ? MUTE_AUDIO : `${hostArgs}\n${MUTE_AUDIO}`,
			},
		};
	};

	/** The server's tool names, page by page. */
	const listTools = async (
		child: McpSession,
		request: { signal: AbortSignal; timeoutMs: number },
	) => {
		const names = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < MAX_TOOL_PAGES; page++) {
			const result = (await child.request(
				"tools/list",
				cursor === undefined ? {} : { cursor },
				request,
			)) as { tools?: { name?: unknown }[]; nextCursor?: unknown } | null;
			for (const tool of result?.tools ?? [])
				if (typeof tool.name === "string") names.add(tool.name);
			if (typeof result?.nextCursor !== "string") return names;
			cursor = result.nextCursor;
		}
		throw new AdapterError("mcp_unavailable", false);
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
			refuseLaunchOptions(options.launch, {
				flags: OWNED_FLAGS,
				variables: OWNED_VARIABLES,
			});
			if (
				options.launch.args.includes("-p") ||
				options.launch.args.some((arg) => UNSAFE_BROWSER_ARGS.test(arg)) ||
				UNSAFE_BROWSER_ARGS.test(options.launch.env?.AGENT_BROWSER_ARGS ?? "")
			)
				throw new AdapterError("launch_not_isolated", false);
			if (signal.aborted) throw new AdapterError("aborted", false);
			signal.addEventListener("abort", onAbort, { once: true });
			await mkdir(cwd, { recursive: true, mode: 0o700 });
			// An empty config of its own: it replaces the user and project config files.
			await writeFile(configPath, "{}", { mode: 0o600 });
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
			// No browser starts yet: the first `open` launches it.
			const names = await listTools(spawned, request);
			if (
				!names.has("agent_browser_open") ||
				!names.has("agent_browser_snapshot")
			)
				throw new AdapterError("mcp_unavailable", false);
			available = names;
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

	/** The call that launches the browser: headed or not and no page-registered tools, as the options say. */
	const launchArgs = () => ({
		headed: !options.browser.headless,
		webmcp: false,
	});

	/** The single door to the child: names outside the closed list cannot be called. */
	const callToolNow = async (
		name: AbToolName,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpToolResult> => {
		if (!isAllowedTool(name)) throw new AdapterError("tool_not_allowed", false);
		const child = session;
		if (!child || state !== "open") throw new AdapterError("not_open", false);
		const send = async (tool: string, toolArgs: Record<string, unknown>) => {
			let raw: McpToolResult;
			try {
				raw = (await child.request(
					"tools/call",
					{ name: tool, arguments: toolArgs },
					{ signal, timeoutMs: callTimeoutMs },
				)) as McpToolResult;
			} catch (error) {
				throw fromTransport(error);
			}
			if (raw.isError) {
				const failure = classifyToolError(textOf(raw), tool);
				throw new ReportedError(failure.code, failure.dispatched);
			}
			return raw;
		};
		try {
			if (!browserStarted) {
				// The browser is launched by a call of its own (a blank page, with the launch settings), and
				// the command follows as it would on a running browser: a navigation never depends on the
				// call that also starts the browser. A failure here means the command was not sent.
				browserStarted = true;
				try {
					await send("agent_browser_open", launchArgs());
				} catch (error) {
					throw new AdapterError(
						error instanceof AdapterError ? error.code : "mcp_unavailable",
						false,
					);
				}
			}
			return await send(name, args);
		} catch (error) {
			if (
				error instanceof AdapterError &&
				(error.code === "process_exited" || error.code === "mcp_unavailable")
			)
				void lose(child, error.code);
			throw error;
		}
	};
	const callTool = (
		name: AbToolName,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	) => serial(signal, () => callToolNow(name, args, signal));

	/** The eval tool runs only scripts the adapter built itself (`FixedScript`: fixed text, validated numbers). */
	const callEval = (script: FixedScript, signal?: AbortSignal) =>
		callTool("agent_browser_eval", { script }, signal);

	const locatable = () =>
		has("agent_browser_get_box") && has("agent_browser_eval");

	/**
	 * Runs a fixed function on the element of a ref (see `locate.ts`): the function's JSON result, or
	 * `undefined` when the element cannot be found again by its box (never a different element).
	 */
	const onElement = async (
		ref: string,
		body: string,
		signal: AbortSignal,
	): Promise<string | undefined> => {
		const box = parseBox(
			await callTool(
				"agent_browser_get_box",
				{ selector: selectorOf(ref) },
				signal,
			),
		);
		return parseLocated(
			evalResult(await callEval(locateScript(body, box), signal)),
		);
	};

	/** The current page; whatever cannot be read is left out (an action that ran stays confirmed). */
	const pageOf = async (signal?: AbortSignal) => {
		const url = await callTool("agent_browser_get_url", {}, signal)
			.then(parseUrl)
			.catch(() => undefined);
		const title = await callTool("agent_browser_get_title", {}, signal)
			.then(parseTitle)
			.catch(() => undefined);
		return { url, title };
	};

	const listTabs = async (signal?: AbortSignal): Promise<AbTab[]> => {
		const tabs = parseTabs(
			await callTool("agent_browser_tab_list", {}, signal),
		);
		if (!tabs) throw new AdapterError("mcp_response_unrecognized", true);
		return tabs;
	};

	const refused = (code: string): AdapterDispatchResult => ({
		status: "not_dispatched",
		code,
		retryable: RETRYABLE_CODES.has(code),
	});

	const runDispatch = async (
		command: AdapterCommand,
		signal: AbortSignal,
	): Promise<AdapterDispatchResult> => {
		let calls: ReturnType<typeof commandCalls>;
		try {
			calls = commandCalls(command, has);
		} catch (error) {
			return refused(
				error instanceof AdapterError ? error.code : "unsupported",
			);
		}
		let effectful = false;
		for (const call of calls) {
			try {
				await callTool(call.tool, call.args, signal);
				// A wait changes nothing; anything else may have.
				if (!call.tool.startsWith("agent_browser_wait_")) effectful = true;
			} catch (error) {
				const failure =
					error instanceof AdapterError
						? error
						: new AdapterError("mcp_unavailable", true);
				// A load that outlasted `open`'s deadline: the state check decides, and nothing is re-sent.
				if (
					command.action === "browser.navigate" &&
					failure instanceof ReportedError &&
					failure.code === "operation_timeout"
				) {
					const { url, title } = await pageOf(signal);
					if (url !== undefined && sameNavigation(command.url, url))
						return {
							status: "confirmed",
							code: "load_timeout",
							retryable: false,
							url,
							...(title ? { title } : {}),
						};
				}
				// A failed later step does not undo an earlier one that took effect.
				if (failure.dispatched || effectful)
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
		}
		// The page may still be on its way after a click, key or submit: a settle hint (its timeout,
		// or any failure, changes nothing) before the url is read.
		if (settles(command) && has("agent_browser_wait_for_load"))
			await callTool(
				"agent_browser_wait_for_load",
				{ state: "domcontentloaded", waitTimeoutMs: SETTLE_TIMEOUT_MS },
				signal,
			).catch(() => {});
		const { url, title } = await pageOf(signal);
		// An open that answered while the tab is still blank did not navigate (a requested url is never blank).
		if (command.action === "browser.navigate" && url === BLANK_PAGE)
			return {
				status: "indeterminate",
				code: "navigation_not_committed",
				retryable: false,
			};
		return {
			status: "confirmed",
			retryable: false,
			...(url !== undefined ? { url } : {}),
			...(title ? { title } : {}),
		};
	};

	/** A new tab's open that answered while the tab is still blank did not navigate. */
	const assertCommitted = async (signal: AbortSignal) => {
		const url = await callTool("agent_browser_get_url", {}, signal)
			.then(parseUrl)
			.catch(() => undefined);
		if (url === BLANK_PAGE)
			throw new AdapterError("navigation_not_committed", true);
	};

	const toTargets = (tabs: AbTab[]): AdapterTarget[] =>
		tabs.map((tab) => ({
			targetRef: tab.id,
			kind: "tab",
			current: tab.current,
			...(tab.url !== "" ? { url: tab.url } : {}),
			...(tab.title !== "" ? { title: tab.title } : {}),
		}));

	return {
		platform: "agent-browser",
		toolInfo: () => ({ name: TOOL_NAME, version: serverVersion }),
		catalog: (): CatalogEntry[] =>
			COMMON_ACTIONS.map((action) => {
				const tools = ACTION_TOOLS[action];
				return {
					action,
					platform: "agent-browser",
					supported: tools !== undefined && tools.every(has),
					needsTargetRef: NEEDS_TARGET_REF.has(action),
					physicalInput: false,
				};
			}),
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
				const closeBrowser = browserStarted;
				session = undefined;
				browserStarted = false;
				state = "closed";
				if (child) {
					if (closeBrowser && !child.exited()) {
						// Let a call in flight finish first, so a browser it is launching is not left behind.
						let wait: ReturnType<typeof setTimeout> | undefined;
						await Promise.race([
							queue.then(
								() => {},
								() => {},
							),
							new Promise<void>((resolve) => {
								wait = setTimeout(resolve, closeWaitMs);
							}),
						]);
						clearTimeout(wait);
						try {
							await child.request(
								"tools/call",
								{ name: "agent_browser_close", arguments: {} },
								{ timeoutMs: closeTimeoutMs },
							);
						} catch {
							// The child is stopped below whatever the close said.
						}
					}
					await child.close();
				}
				if (wasOpen) log("adapter.closed", {});
			})().finally(() => {
				closing = undefined;
			});
			return closing;
		},
		state: () => state,
		listTargets: (signal) =>
			readOnly(async () => toTargets(await listTabs(signal))),
		async selectTarget(targetRef, signal) {
			const tab = tabIdOf(targetRef);
			await callTool("agent_browser_tab_switch", { tab }, signal);
			return toTargets(await listTabs(signal));
		},
		async newTarget(url, signal) {
			const target = webUrl(url);
			// Before the browser exists, the first open is the new tab.
			if (!browserStarted) {
				await callTool(
					"agent_browser_open",
					{ url: target, timeoutMs: OPEN_TIMEOUT_MS },
					signal,
				);
				await assertCommitted(signal);
				return toTargets(await listTabs(signal));
			}
			// `tab_new` with a url navigates asynchronously and leaves the commands on the old tab, so
			// the tab is made empty, switched to, and only then opened on the url.
			const before = new Set((await listTabs(signal)).map((tab) => tab.id));
			await callTool("agent_browser_tab_new", {}, signal);
			const added = (await listTabs(signal)).filter(
				(tab) => !before.has(tab.id),
			);
			if (added.length !== 1 || added[0] === undefined)
				throw new AdapterError("mcp_response_unrecognized", true);
			await callTool("agent_browser_tab_switch", { tab: added[0].id }, signal);
			try {
				await callTool(
					"agent_browser_open",
					{ url: target, timeoutMs: OPEN_TIMEOUT_MS },
					signal,
				);
			} catch (error) {
				// A load that outlasted the deadline is fine when the tab is on the requested page.
				if (!(
					error instanceof ReportedError && error.code === "operation_timeout"
				))
					throw error;
				const { url: now } = await pageOf(signal);
				if (now === undefined || !sameNavigation(target, now)) throw error;
			}
			await assertCommitted(signal);
			return toTargets(await listTabs(signal));
		},
		observe: (signal) =>
			loggedRead(log, async (): Promise<RawObservation> => {
				const raw = await callTool(
					"agent_browser_snapshot",
					snapshotArgs,
					signal,
				);
				if (raw.content?.[0]?.type !== "text")
					throw new AdapterError("mcp_response_unrecognized", false);
				const { url, title } = await pageOf(signal);
				return {
					body: textOf(raw),
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
				log,
				async () => {
					const cap = extractCap(maxChars);
					if (targetRef === null) {
						if (!has("agent_browser_eval"))
							throw new AdapterError("unsupported", false);
						return parseExtraction(
							evalResult(await callEval(EXTRACT_SCRIPT, signal)),
							false,
							cap,
						);
					}
					const selector = selectorOf(targetRef);
					// The same function as without a ref, on the element found again by its box.
					if (locatable()) {
						try {
							const found = await onElement(
								targetRef,
								EXTRACT_TARGET_FUNCTION,
								signal,
							);
							if (found !== undefined) return parseExtraction(found, true, cap);
						} catch (error) {
							if (!(
								error instanceof AdapterError && error.code === "unsupported"
							))
								throw error;
						}
					}
					// Otherwise the element's own text, normalised (nothing inside it is dropped).
					if (!has("agent_browser_get_text"))
						throw new AdapterError("unsupported", false);
					const raw = await callTool(
						"agent_browser_get_text",
						{ selector },
						signal,
					);
					return extractionFromText(textOf(raw), await pageOf(signal), cap);
				},
				(content) => content.charCount,
			),
		async inspect(kind: FixedInspection, targetRef, signal) {
			if (signal.aborted) throw new AdapterError("cancelled", false);
			switch (kind) {
				case "inspectFocused":
					if (!has("agent_browser_eval"))
						throw new AdapterError("unsupported", false);
					return readOnly(async () =>
						parseTargetInspection(
							evalResult(await callEval(INSPECT_FOCUSED_SCRIPT, signal)),
						),
					);
				case "inspectTarget":
				case "inspectLocator": {
					if (!locatable()) throw new AdapterError("unsupported", false);
					const target = kind === "inspectTarget";
					return readOnly(async () => {
						const found = await onElement(
							refOf(targetRef),
							target ? INSPECT_TARGET_FUNCTION : INSPECT_LOCATOR_FUNCTION,
							signal,
						);
						// No match (covered, off-screen, other coordinates): nothing is guessed.
						if (found === undefined)
							throw new AdapterError("unsupported", false);
						return target
							? parseTargetInspection(found)
							: parseLocatorInspection(found);
					});
				}
				default:
					throw new AdapterError("unsupported", false);
			}
		},
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
	};
}
