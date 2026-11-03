/**
 * Origins and https URLs, parsed by hand: the pure code has no `URL` global. Deliberately narrower than the
 * WHATWG parser: only ASCII dotted host names (no IP literals, no percent-encoding, no trailing dot, no
 * backslashes), so a string that a browser might read differently from this code is refused, not guessed.
 */

const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export type ParsedOrigin = { host: string; port: number };

function portOf(text: string | undefined) {
	if (text === undefined) return 443;
	if (!/^\d{1,5}$/.test(text)) return null;
	const port = Number(text);
	return port >= 1 && port <= 65535 ? port : null;
}

/** `host[:port]` of an authority without userinfo; the host is lowercased. */
function hostPort(authority: string): ParsedOrigin | null {
	const at = authority.lastIndexOf(":");
	const host = (at < 0 ? authority : authority.slice(0, at)).toLowerCase();
	const port = portOf(at < 0 ? undefined : authority.slice(at + 1));
	return HOST.test(host) && port !== null ? { host, port } : null;
}

/** The normalised origin text: lowercase host, the default port dropped. */
export const originText = (o: ParsedOrigin) =>
	`https://${o.host}${o.port === 443 ? "" : `:${o.port}`}`;

/** `https://host[:port]` and nothing after it; null for anything else. */
export function parseOrigin(origin: string): ParsedOrigin | null {
	const match = /^https:\/\/([^/?#@\\]*)$/i.exec(origin);
	return match ? hostPort(match[1]!) : null;
}

export type UrlCheck =
	| { ok: true; origin: ParsedOrigin }
	| { ok: false; code: "url_invalid" | "url_not_https" | "url_userinfo" };

/** Whether a URL is an https URL without userinfo, and its origin. The scheme and host are case-insensitive. */
export function checkHttpsUrl(url: string): UrlCheck {
	const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(?:[/?#].*)?$/s.exec(
		url,
	);
	if (!match) return { ok: false, code: "url_invalid" };
	if (match[1]!.toLowerCase() !== "https")
		return { ok: false, code: "url_not_https" };
	const authority = match[2]!;
	if (authority.includes("@")) return { ok: false, code: "url_userinfo" };
	const origin = hostPort(authority);
	return origin ? { ok: true, origin } : { ok: false, code: "url_invalid" };
}

/** A pattern of `allowedOrigins`: `https://host[:port]` or `https://*.domain`. */
export function parsePattern(
	pattern: string,
): (ParsedOrigin & { wildcard: boolean }) | null {
	const wildcard = pattern.startsWith("https://*.");
	const origin = parseOrigin(
		wildcard ? `https://${pattern.slice(10)}` : pattern,
	);
	return origin ? { ...origin, wildcard } : null;
}

/**
 * Whether `origin` is allowed by the patterns. `https://host[:port]` matches exactly (the default port is
 * 443). `https://*.example.org` matches `example.org` and its subdomains at any depth, on the default port
 * only; `evilexample.org` and `example.org.evil.com` do not match.
 */
export function originAllowed(
	allowedOrigins: readonly string[],
	origin: string,
): boolean {
	const target = parseOrigin(origin);
	if (!target) return false;
	return allowedOrigins.some((pattern) => {
		const allowed = parsePattern(pattern);
		if (!allowed) return false;
		if (!allowed.wildcard)
			return allowed.host === target.host && allowed.port === target.port;
		return (
			allowed.port === 443 &&
			target.port === 443 &&
			(target.host === allowed.host || target.host.endsWith(`.${allowed.host}`))
		);
	});
}
