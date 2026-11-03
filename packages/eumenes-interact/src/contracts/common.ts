/**
 * Shared identifiers of eumenes-interact (plan.md §3, §5). Pure types: no IO, no Bun or DOM APIs.
 * Owned by the supervisor; workers do not edit files under `src/contracts/`.
 */

/**
 * Platform identifiers. `agent-browser` was compared and not adopted (plan.md §12.1, 2026-11-03); its
 * adapter is removed, and the id stays only so recorded comparison trials and the frozen schema keep
 * their meaning.
 */
export const PLATFORM_IDS = [
	"playwright-mcp",
	"agent-browser",
	"agent-desktop",
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

/**
 * The owner the host hands in (plan.md §3.3 scope). The package only filters by it; it never
 * authenticates and never derives it from JSON, Skill text or page content.
 */
export type OwnerScope = string;

/** Fixed event names the package may report through the host's logger port. */
export type InteractEventName =
	| "core.step.prepared"
	| "core.step.parsed"
	| "core.step.rejected"
	| "core.result.applied"
	| "adapter.opened"
	| "adapter.closed"
	| "adapter.observed"
	| "adapter.dispatched"
	| "adapter.failed"
	| "sqlite.migrated"
	| "sqlite.conflict"
	| "inference.connected"
	| "inference.released"
	| "inference.completed"
	| "inference.failed";

/**
 * Log fields: a correlation id, a fixed classification code, counts and durations only
 * (plan.md §14). Never observation text, input values, URLs with credentials or provider output.
 */
export type InteractLogFields = {
	correlationId: string;
	code?: string;
	count?: number;
	durationMs?: number;
};

export interface LoggerPort {
	event(name: InteractEventName, fields: InteractLogFields): void;
}

/** A logger that drops everything (for tests and hosts without logging). */
export const silentLogger: LoggerPort = { event() {} };
