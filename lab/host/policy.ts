/**
 * The destination policy of the research host (plan.md §9, §14): the scope boundary. Fixtures are served
 * from one loopback origin that exists only during a run, so a page is allowed only at that exact origin
 * (scheme, host and port) or at `about:blank`; every other destination is refused before it is sent,
 * including other loopback ports, credentialed URLs and non-http(s) schemes.
 *
 * Host difference from Eumenes (`browser/service/policy.ts` and `navigation.ts`, commit 98b188d2): Eumenes
 * refuses loopback and private addresses and allows the open web; this host allows exactly one loopback origin
 * and nothing else.
 */

import { originAllowed } from "eumenes-interact";
import { isPrivateHost, privateIpv4 } from "eumenes-interact/parts";

// The host rules live in the package (design R08); re-exported for the lab's callers and tests.
export { isPrivateHost, privateIpv4 };

export type UrlVerdict =
	{ ok: true; url: string } | { ok: false; code: string };
export type UrlPolicy = (raw: string) => UrlVerdict;

const MAX_URL_CHARS = 2048;

/** Percent-decoded twice, one slash style, case folded: `%2e%2e` and `\` cannot walk out of the root. */
function decoded(path: string) {
	let value = path;
	for (let i = 0; i < 2; i++) {
		try {
			value = decodeURIComponent(value);
		} catch {
			break;
		}
	}
	return value
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.toLowerCase();
}

/** `baseUrl` is the fixture server's base, `http://127.0.0.1:<port>/`. */
export function fixturePolicy(baseUrl: string): UrlPolicy {
	const base = new URL(baseUrl);
	if (base.protocol !== "http:" && base.protocol !== "https:")
		throw new Error("base_url_not_http");
	if (!base.pathname.endsWith("/")) throw new Error("base_url_needs_slash");
	const root = decoded(base.pathname);
	return (raw) => {
		if (raw.length > MAX_URL_CHARS)
			return { ok: false, code: "navigation_invalid_url" };
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			return { ok: false, code: "navigation_invalid_url" };
		}
		if (url.href === "about:blank") return { ok: true, url: url.href };
		if (url.protocol !== "http:" && url.protocol !== "https:")
			return { ok: false, code: "navigation_scheme_blocked" };
		if (url.username || url.password)
			return { ok: false, code: "navigation_credentials_blocked" };
		if (url.origin !== base.origin)
			return { ok: false, code: "navigation_out_of_scope" };
		const path = decoded(url.pathname);
		if (path.split("/").includes("..") || !path.startsWith(root))
			return { ok: false, code: "navigation_out_of_scope" };
		return { ok: true, url: url.href };
	};
}

/**
 * The policy of a live run or a work definition (plan.md §6, §10.2): exactly the `allowedOrigins` (scheme,
 * host and port; `https://*.domain` allows the domain and its subdomains on the default port) and
 * `about:blank`. Credentials, non-http(s) schemes, other origins and loopback/private/link-local hosts are
 * refused, even if an origin list named one. Unlike the fixture policy it may be a real site, so the private
 * address rules of Eumenes' web policy apply. `openWeb` (a chain step, user decision 2026-11-04) drops only
 * the origin list: every other refusal stays.
 */
export function originPolicy(
	allowedOrigins: readonly string[],
	openWeb = false,
): UrlPolicy {
	return (raw) => {
		if (raw.length > MAX_URL_CHARS)
			return { ok: false, code: "navigation_invalid_url" };
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			return { ok: false, code: "navigation_invalid_url" };
		}
		if (url.href === "about:blank") return { ok: true, url: url.href };
		if (url.protocol !== "http:" && url.protocol !== "https:")
			return { ok: false, code: "navigation_scheme_blocked" };
		if (url.username || url.password)
			return { ok: false, code: "navigation_credentials_blocked" };
		if (isPrivateHost(url.hostname))
			return { ok: false, code: "navigation_private_blocked" };
		if (!openWeb && !originAllowed(allowedOrigins, url.origin))
			return { ok: false, code: "navigation_out_of_scope" };
		return { ok: true, url: url.href };
	};
}
