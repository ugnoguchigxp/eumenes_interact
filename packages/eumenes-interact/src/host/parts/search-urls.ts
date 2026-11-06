/**
 * Site search pages the host knows (site knowledge, not page content): when a site's search box cannot be
 * found or used, `site.search` opens the site's own results page for the query instead. `{q}` is the query,
 * URL-encoded. The last resort is a general search engine for "site:<host> <query>", only where the run's URL
 * policy allows it. Add a site here when its search page is stable and needs no login.
 */
import { compilePattern, DEFAULT_LEXICON } from "../../core/shared/lexicon.ts";

/** The general engine of the last resort (HTML results, no script needed). */
export const GENERAL_SEARCH = "https://html.duckduckgo.com/html/?q={q}";

const fill = (template: string, query: string) =>
	template.replace("{q}", encodeURIComponent(query));

/** The site's own search page for the query, if the host knows one for this page's host. */
export function generalSearchUrl(
	pageUrl: string,
	query: string,
): string | null {
	try {
		return fill(GENERAL_SEARCH, `site:${new URL(pageUrl).hostname} ${query}`);
	} catch {
		return null;
	}
}

/**
 * A bot check instead of the page (Cloudflare and the like). The host never solves or clicks it: it waits once
 * for an automatic pass, then reports `site_blocked`.
 */
const CHALLENGE = compilePattern(DEFAULT_LEXICON.botCheck);

export function isChallenge(title: string | undefined, body: string): boolean {
	if (title && CHALLENGE.test(title)) return true;
	// A real page that mentions a captcha somewhere is long; a challenge page is short.
	return body.length < 4000 && CHALLENGE.test(body);
}
