import { Refusal } from "./types.ts";

/**
 * Input values a run may type (Eumenes `browser/service/grants.ts`, commit 98b188d2; plan.md §9). A value
 * gets a ref only from the user's approval, or comes from a passage of the request: the core already
 * stops a quote that is not in the request, and the host checks the same thing again before sending because
 * the model's call is not trusted. Nothing a page showed can supply a quote.
 */

/** Width, case, spacing and the separators people add to numbers do not change what was asked. */
const squash = (s: string) =>
	s
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\-ー‐–—,，、/／]+/g, "");

const QUOTE_MIN = 2;
const QUOTE_VALUE_FACTOR = 4;
const QUOTE_VALUE_SLACK = 32;
const GRANT_MS = 10 * 60_000;

/** The origin of an http(s) page, or null (a value is bound to a site; other pages have none). */
export function grantOrigin(raw: string): string | null {
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.origin
			: null;
	} catch {
		return null;
	}
}

/** A reformatted value is allowed, a value much longer than its passage or a passage too short is not. */
export function assertQuoted(value: string, quote: string, request: string) {
	const q = squash(quote);
	if (
		q.length < QUOTE_MIN ||
		value.length > QUOTE_VALUE_FACTOR * q.length + QUOTE_VALUE_SLACK ||
		!squash(request).includes(q)
	)
		throw new Refusal("grant_source_mismatch");
}

type Grant = { value: string; origin: string; purpose: string; until: number };

export class InputGrants {
	private readonly grants = new Map<string, Grant>();

	constructor(
		private readonly now: () => number,
		private readonly newRef: () => string,
	) {}

	/** The user allowed `value` for `purpose` on `origin`: the ref the core will show in `approved`. */
	approve(input: { value: string; origin: string; purpose: string }) {
		const origin = grantOrigin(input.origin);
		if (!origin || !input.value || input.value.length > 2000)
			throw new Refusal("grant_invalid", false);
		const inputValueRef = this.newRef();
		this.grants.set(inputValueRef, {
			value: input.value,
			origin,
			purpose: input.purpose.slice(0, 60),
			until: this.now() + GRANT_MS,
		});
		return { inputValueRef, origin, purpose: input.purpose.slice(0, 60) };
	}

	/**
	 * The value of one use. The core's call carries no purpose, so the site is the binding checked here
	 * (Eumenes also checks the purpose it was granted for).
	 */
	use(ref: string, pageUrl: string): string {
		const grant = this.grants.get(ref);
		if (!grant) throw new Refusal("grant_not_found");
		if (grant.until <= this.now()) throw new Refusal("grant_expired");
		if (grant.origin !== grantOrigin(pageUrl))
			throw new Refusal("grant_mismatch");
		return grant.value;
	}
}
