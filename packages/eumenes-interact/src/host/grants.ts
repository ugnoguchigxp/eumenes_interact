import { Refusal } from "./errors.ts";

/**
 * Input values a run may type (Eumenes `browser/service/grants.ts`, commit 98b188d2; plan.md §9). A value
 * gets a ref only from the user's approval, or comes from a passage of the request: the core already
 * stops a quote that is not in the request, and the host checks the same thing again before sending because
 * the model's call is not trusted (the rules are in `source.ts`). Nothing a page showed can supply a quote.
 */

const GRANT_MS = 10 * 60_000;

/** Plain http carries an approved value in clear text: only a loopback host (the lab's fixtures) may use it. */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/**
 * The origin of an https page, or of an http page on loopback, or null (a value is bound to a site; other pages
 * have none).
 */
export function grantOrigin(raw: string): string | null {
	try {
		const url = new URL(raw);
		if (url.protocol === "https:") return url.origin;
		return url.protocol === "http:" && LOOPBACK.test(url.hostname)
			? url.origin
			: null;
	} catch {
		return null;
	}
}

type Grant = { value: string; origin: string; purpose: string; until: number };

/** Exactly the purpose it was approved for (both cut at 60 characters, as Eumenes stores it); none asked, none checked. */
const samePurpose = (grant: Grant, purpose: string | undefined) =>
	purpose === undefined || grant.purpose === purpose.slice(0, 60);

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
		// Grants expired for a whole grant period are dropped here, so a long run that approves often does not keep
		// every past value; a ref used soon after it expired still answers grant_expired, not grant_not_found.
		const now = this.now();
		for (const [ref, grant] of this.grants)
			if (grant.until + GRANT_MS <= now) this.grants.delete(ref);
		const inputValueRef = this.newRef();
		this.grants.set(inputValueRef, {
			value: input.value,
			origin,
			purpose: input.purpose.slice(0, 60),
			until: now + GRANT_MS,
		});
		return { inputValueRef, origin, purpose: input.purpose.slice(0, 60) };
	}

	/**
	 * The ref of a live grant for exactly this value on this page's site (and, when `purpose` is given, approved
	 * for exactly that purpose), or null. Arm 1's `form.fill` carries
	 * the value itself, so what the user approved is found by its value; the value is then used through the
	 * ref like any other (`use` checks the site and the time again).
	 */
	find(value: string, pageUrl: string, purpose?: string): string | null {
		const origin = grantOrigin(pageUrl);
		for (const [ref, grant] of this.grants)
			if (
				grant.value === value &&
				grant.origin === origin &&
				grant.until > this.now() &&
				samePurpose(grant, purpose)
			)
				return ref;
		return null;
	}

	/**
	 * The value of one use, bound to the site and, as Eumenes binds a grant (`createGrants.useInTransaction`: same
	 * origin, same purpose cut at 60 characters), to the purpose it was approved for. A caller that knows what the
	 * value is for passes `purpose`; the core's call carries none, so without it only the site is checked (the
	 * 0.1 behaviour). The purpose is the host's own knowledge (a form field's label, a definition step), never
	 * the model's.
	 */
	use(ref: string, pageUrl: string, purpose?: string): string {
		const grant = this.grants.get(ref);
		if (!grant) throw new Refusal("grant_not_found");
		if (grant.until <= this.now()) throw new Refusal("grant_expired");
		if (grant.origin !== grantOrigin(pageUrl) || !samePurpose(grant, purpose))
			throw new Refusal("grant_mismatch");
		return grant.value;
	}
}
