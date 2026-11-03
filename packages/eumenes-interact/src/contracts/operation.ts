import type { PlatformId } from "./common.ts";

/**
 * Operations (plan.md §5.1, §5.5). The common action vocabulary between the core, the host and the
 * adapters. A platform that cannot give an action the same meaning reports it unsupported; it never
 * substitutes a fixed key sequence.
 */

export const COMMON_ACTIONS = [
	"page.observe",
	"page.click",
	"page.hover",
	"page.fill",
	"page.select",
	"page.press",
	"page.scroll",
	"page.wait",
	"page.capture",
	"page.extract",
	"browser.navigate",
	"browser.back",
	"browser.tabs",
	"browser.selectTab",
] as const;
export type CommonActionId = (typeof COMMON_ACTIONS)[number];

/** A command the host sends to an adapter. `targetRef` comes from the latest observation of the target. */
export type AdapterCommand =
	| { action: "browser.navigate"; url: string }
	| { action: "browser.back" }
	| { action: "page.click"; targetRef: string; element: string }
	| { action: "page.hover"; targetRef: string; element: string }
	| {
			action: "page.fill";
			targetRef: string;
			element: string;
			text: string;
			submit: boolean;
	  }
	| {
			action: "page.select";
			targetRef: string;
			element: string;
			values: string[];
	  }
	| { action: "page.press"; key: string }
	| {
			action: "page.scroll";
			direction: "up" | "down";
			targetRef?: string;
	  }
	| { action: "page.wait"; text?: string; textGone?: string; seconds?: number };
export type AdapterCommandAction = AdapterCommand["action"];

/** What the caller declares an operation may do. A declaration never proves the absence of an effect. */
export type DeclaredEffect =
	"none" | "navigation" | "input" | "submit" | "unknown";

/**
 * Operation status (plan.md §5.5).
 * - not_dispatched: nothing was sent to the platform.
 * - dispatched: written by the host before awaiting the adapter; the outcome is not known yet.
 * - confirmed: the platform reported the command ran. This is acceptance, not goal achievement.
 * - failed: the platform reported an error and the command is known not to have taken effect.
 * - indeterminate: the command may have reached the page (transport lost, timeout after send…).
 *   Never re-sent automatically.
 */
export const OPERATION_STATUSES = [
	"not_dispatched",
	"dispatched",
	"confirmed",
	"failed",
	"indeterminate",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export type OperationRequest = {
	operationId: string;
	sessionId: string;
	generation: number;
	observationRef?: string;
	command: AdapterCommand;
	declaredEffect: DeclaredEffect;
	approvalRef?: string;
};

export type OperationResult = {
	operationId: string;
	status: Exclude<OperationStatus, "dispatched">;
	/** Fixed failure classification (adapter vocabulary, e.g. "stale_ref", "transport_lost"). */
	code?: string;
	/** The adapter's statement from the platform's guarantee and the real dispatch state; the host decides. */
	retryable: boolean;
	url?: string;
	title?: string;
};

/** One action as an adapter offers it at run time (plan.md §5.1 catalog). No command templates. */
export type CatalogEntry = {
	action: CommonActionId | `${PlatformId}.${string}`;
	platform: PlatformId;
	supported: boolean;
	needsTargetRef: boolean;
	/** True when the platform moves the real pointer/keyboard focus (not allowed in the initial scope). */
	physicalInput: boolean;
};
