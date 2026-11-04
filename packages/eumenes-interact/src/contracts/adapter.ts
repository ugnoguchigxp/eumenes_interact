import type { LoggerPort, PlatformId } from "./common.ts";
import type { ExtractedContent, RawObservation } from "./observation.ts";
import type {
	AdapterCommand,
	CatalogEntry,
	OperationResult,
} from "./operation.ts";

/**
 * The adapter port (plan.md §5.2). One adapter instance drives one platform session. The host
 * serialises calls: one call at a time per session. Adapters may use `node:` APIs only (no `Bun.*`).
 */

/** The executable the host hands in. The package depends on no external tool. */
export type AdapterLaunch = {
	command: string;
	args: readonly string[];
	cwd?: string;
	env?: Readonly<Record<string, string>>;
};

export type AdapterOptions = {
	launch: AdapterLaunch;
	/** Directory the adapter may write to (platform output, traces). Created and cleaned by the host. */
	workDir: string;
	logger: LoggerPort;
	correlationId: string;
	/** Optional per-call timeouts; adapters keep their own defaults. */
	connectTimeoutMs?: number;
	callTimeoutMs?: number;
};

export type AdapterState = "closed" | "opening" | "open" | "lost";

/**
 * A tab or window as the platform lists it. `targetRef` is platform-native and may be unstable
 * (Playwright MCP: the tab index); the host keeps its own stable refs and re-lists before selecting.
 */
export type AdapterTarget = {
	targetRef: string;
	kind: "tab" | "window";
	current: boolean;
	url?: string;
	title?: string;
	app?: string;
};

/** Read-only fixed inspections (functions with no model input in them). */
export type FixedInspection =
	| "inspectTarget"
	| "inspectFocused"
	| "inspectLocator"
	/** The largest video on the page: where it is in playback, never its content. */
	| "inspectMedia";

/** The element facts a fixed inspection read. Values are attribute facts only, never page text. */
export type InspectionResult = Readonly<
	Record<string, string | boolean | number | null>
>;

/** A screenshot as an adapter returns it; dimensions are read from the image header. */
export type CapturedImage = {
	mediaType: "image/png" | "image/jpeg";
	bytes: Uint8Array;
	width: number;
	height: number;
};

/** An adapter result. `operationId` is filled in by the host; adapters return the rest. */
export type AdapterDispatchResult = Omit<OperationResult, "operationId">;

export class AdapterError extends Error {
	constructor(
		readonly code: string,
		/** The call may have reached the page (the host records indeterminate). */
		readonly dispatched: boolean,
	) {
		super(code);
		this.name = "AdapterError";
	}
}

export interface PlatformAdapter {
	readonly platform: PlatformId;
	/** The external tool actually used, for trial records (plan.md §14). `version` null when unknown. */
	toolInfo(): { name: string; version: string | null };
	catalog(): readonly CatalogEntry[];
	/** Starts the platform session (child process etc.). Rejects with AdapterError. */
	open(signal: AbortSignal): Promise<void>;
	/** Stops only what this adapter started. Idempotent. */
	close(): Promise<void>;
	state(): AdapterState;
	listTargets(signal: AbortSignal): Promise<AdapterTarget[]>;
	selectTarget(
		targetRef: string,
		signal: AbortSignal,
	): Promise<AdapterTarget[]>;
	/** Opens a new tab/window on `url` (browser platforms). */
	newTarget(url: string, signal: AbortSignal): Promise<AdapterTarget[]>;
	/** Observes the current target. Read-only: an error never reached the page. */
	observe(signal: AbortSignal): Promise<RawObservation>;
	/** Never throws for platform failures: they come back as a result with a status. */
	dispatch(
		command: AdapterCommand,
		signal: AbortSignal,
	): Promise<AdapterDispatchResult>;
	/**
	 * Read-only (`page.extract`): the main text of the current target by a fixed function with no model
	 * input. `targetRef` names the content root from the latest observation; null uses the generic order
	 * (article → main → largest text block → body). `maxChars` caps the text (adapters keep a hard upper bound).
	 */
	extract(
		targetRef: string | null,
		maxChars: number,
		signal: AbortSignal,
	): Promise<ExtractedContent>;
	/**
	 * Read-only screenshot of the current target (plan.md §6.4): the viewport, the full page, or the element
	 * of an observed ref. Returns the image bytes; saving them and handing them to an AI are the host's job.
	 */
	capture(
		range: "viewport" | "full" | "item",
		targetRef: string | null,
		signal: AbortSignal,
	): Promise<CapturedImage>;
	/** Read-only. `targetRef` null for `inspectFocused`. Unsupported kinds reject with AdapterError("unsupported"). */
	inspect(
		kind: FixedInspection,
		targetRef: string | null,
		signal: AbortSignal,
	): Promise<InspectionResult>;
}
