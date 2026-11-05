import type { InferencePort } from "eumenes-interact";
/** Every inference purpose shares one counter; a resumed choice keeps the same step scope. */
export class CallBudget {
	used = 0;
	private readonly scopes = new Map<string, number>();
	constructor(private maximum: number) {
		const limit = maximum;
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw new Error("invalid_call_budget");
	}
	get limit() {
		return this.maximum;
	}
	/** Planning may tighten the pre-authorized overall bound, never extend it. */
	constrain(limit: number) {
		if (
			!Number.isSafeInteger(limit) ||
			limit < this.used ||
			limit < 1 ||
			limit > this.maximum
		)
			throw new Error("invalid_call_budget");
		this.maximum = limit;
	}
	scopeUsed(scope: string) {
		return this.scopes.get(scope) ?? 0;
	}
	remaining(scope: string, scopeLimit: number) {
		return Math.max(
			0,
			Math.min(this.maximum - this.used, scopeLimit - this.scopeUsed(scope)),
		);
	}
	port(inner: InferencePort, scope: string, scopeLimit: number): InferencePort {
		return {
			complete: async (request) => {
				request.signal.throwIfAborted();
				const used = this.scopes.get(scope) ?? 0;
				if (this.used >= this.limit || used >= scopeLimit)
					throw new Error("inference_budget_exhausted");
				this.used++;
				this.scopes.set(scope, used + 1);
				return inner.complete(request);
			},
		};
	}
}
