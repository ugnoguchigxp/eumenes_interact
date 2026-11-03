/**
 * Run states (plan.md §9). Accepted is not completed: a run that confirmed only part of its goal is
 * `partial`, and one whose sent operation has an unknown outcome is `indeterminate`.
 */
export const RUN_STATUSES = [
	"queued",
	"running",
	"needs_input",
	"completed",
	"partial",
	"failed",
	"cancelled",
	"expired",
	"indeterminate",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = [
	"completed",
	"partial",
	"failed",
	"cancelled",
	"expired",
	"indeterminate",
] as const satisfies readonly RunStatus[];
