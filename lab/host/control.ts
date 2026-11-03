import { RunEnd } from "./types.ts";

export type CancelReason = "cancel" | "deadline";

/**
 * Cancellation of one run (plan.md §9). `cancel` is synchronous and idempotent; listeners on `signal` run
 * inside it, which is where the run is moved to `cancelled`/`expired` before anything else can be sent.
 */
export class RunControl {
	private readonly controller = new AbortController();
	reason: CancelReason | null = null;

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	cancel(reason: CancelReason = "cancel") {
		if (this.reason) return;
		this.reason = reason;
		this.controller.abort(reason);
	}

	/** The end a cancelled run takes; call only after `cancel`. */
	ended(): RunEnd {
		return this.reason === "deadline"
			? new RunEnd("expired", "deadline")
			: new RunEnd("cancelled", "cancel");
	}
}
