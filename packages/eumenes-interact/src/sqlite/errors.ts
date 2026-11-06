/**
 * Store errors of `eumenes-interact/sqlite`. The message is the fixed code: it never carries a value,
 * an id, SQL or page content. `field` names the offending input (a code identifier, never its value).
 */

export const STORE_ERROR_CODES = [
	/** A writer ran outside the host's transaction (`inTransaction === false`). */
	"not_in_transaction",
	"readonly_connection",
	/** An `interact_*` table is missing: the host has not applied the migrations. */
	"schema_missing",
	/** A stored row does not have the shape the package wrote. */
	"corrupt_row",
	/** An argument failed validation (see `field`). */
	"invalid_input",
	/** The origin is not a normalized `http(s)://host[:port]`. */
	"invalid_origin",
	"not_found",
	"already_exists",
	/** The caller's expected revision is not the current one, or the same revision exists with other content. */
	"revision_conflict",
	/** A revision upsert changed nothing: the stored revision is already newer than the one offered. */
	"stale_revision",
	/** The status change is not in the allowed-transition table. */
	"invalid_transition",
	/** A referenced run, operation or candidate belongs to another owner or object. */
	"scope_mismatch",
	/** An operation was recorded or dispatched for a run that is not `running`. */
	"run_not_running",
	"run_not_terminal",
	/**
	 * The run has an operation in `dispatched` or `indeterminate`: nothing new is recorded or sent and
	 * the run does not complete until it is settled (plan.md §9: never resend an unknown operation).
	 */
	"operation_unsettled",
	/** The run is in a terminal state; its stored state no longer changes. */
	"run_closed",
	/** A row the schema keeps immutable (terminal run/operation, workflow revision). */
	"immutable",
] as const;
export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

export class InteractStoreError extends Error {
	override readonly name = "InteractStoreError";
	readonly code: StoreErrorCode;
	readonly field?: string;

	constructor(code: StoreErrorCode, field?: string) {
		super(code);
		this.code = code;
		if (field !== undefined) this.field = field;
	}
}

/** `instanceof` plus a structural check, so copies of the package still recognize each other. */
export function isInteractStoreError(
	value: unknown,
): value is InteractStoreError {
	if (value instanceof InteractStoreError) return true;
	if (!(value instanceof Error)) return false;
	const candidate = value as unknown as Record<string, unknown>;
	return (
		candidate["name"] === "InteractStoreError" &&
		typeof candidate["code"] === "string" &&
		(STORE_ERROR_CODES as readonly string[]).includes(candidate["code"])
	);
}
