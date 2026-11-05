/** A refusal before anything was sent: the code goes back to the model as the tool's result. */
export class Refusal extends Error {
	constructor(
		readonly code: string,
		readonly retryable = true,
	) {
		super(code);
		this.name = "Refusal";
	}
}

/** Why a run ends from inside the executor, not through the core. */
export type RunEndStatus = "cancelled" | "expired" | "indeterminate" | "failed";

export class RunEnd extends Error {
	constructor(
		readonly status: RunEndStatus,
		readonly code: string,
	) {
		super(`${status}:${code}`);
		this.name = "RunEnd";
	}
}
