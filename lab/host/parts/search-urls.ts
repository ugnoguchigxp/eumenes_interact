/**
 * Site search pages the host knows (site knowledge, not page content): when a site's search box cannot be
 * found or used, `site.search` opens the site's own results page for the query instead. `{q}` is the query,
 * URL-encoded. The last resort is a general search engine for "site:<host> <query>", only where the run's URL
 * policy allows it. Add a site here when its search page is stable and needs no login.
 */
export const SEARCH_URLS: Readonly<Record<string, string>> = {
	// A key may name a host and its first path segment: a product inside a larger site.
	"www.google.com/finance": "https://www.google.com/finance/?q={q}",
	"cookpad.com": "https://cookpad.com/jp/search/{q}",
	"www.openstreetmap.org": "https://www.openstreetmap.org/search?query={q}",
	"developer.mozilla.org": "https://developer.mozilla.org/en-US/search?q={q}",
	"tenki.jp": "https://tenki.jp/search/?keyword={q}",
	"docs.python.org": "https://docs.python.org/3/search.html?q={q}",
	"www.artic.edu": "https://www.artic.edu/collection?q={q}",
	"arxiv.org": "https://arxiv.org/search/?query={q}&searchtype=all",
	"www.npmjs.com": "https://www.npmjs.com/search?q={q}",
	"www.youtube.com": "https://www.youtube.com/results?search_query={q}",
	"openlibrary.org": "https://openlibrary.org/search?q={q}",
	"data.worldbank.org": "https://data.worldbank.org/search?q={q}",
	"www.google.com": "https://www.google.com/search?q={q}",
	"en.wikipedia.org": "https://en.wikipedia.org/w/index.php?search={q}",
	"ja.wikipedia.org": "https://ja.wikipedia.org/w/index.php?search={q}",
	"github.com": "https://github.com/search?q={q}&type=repositories",
	"www.reddit.com": "https://www.reddit.com/search/?q={q}",
	"news.ycombinator.com": "https://hn.algolia.com/?q={q}",
	"stackoverflow.com": "https://stackoverflow.com/search?q={q}",
	"www.amazon.co.jp": "https://www.amazon.co.jp/s?k={q}",
	"zenn.dev": "https://zenn.dev/search?q={q}",
	"qiita.com": "https://qiita.com/search?q={q}",
	"pypi.org": "https://pypi.org/search/?q={q}",
	"crates.io": "https://crates.io/search?q={q}",
	"www.bbc.com": "https://www.bbc.com/search?q={q}",
	"www.nhk.or.jp": "https://www3.nhk.or.jp/news/word/search.html?q={q}",
};

/** The general engine of the last resort (HTML results, no script needed). */
export const GENERAL_SEARCH = "https://html.duckduckgo.com/html/?q={q}";

const fill = (template: string, query: string) =>
	template.replace("{q}", encodeURIComponent(query));

/** The site's own search page for the query, if the host knows one for this page's host. */
export function siteSearchUrl(pageUrl: string, query: string): string | null {
	let host: string;
	let section: string;
	try {
		const url = new URL(pageUrl);
		host = url.hostname;
		section = url.pathname.split("/")[1] ?? "";
	} catch {
		return null;
	}
	const template =
		(section ? SEARCH_URLS[`${host}/${section}`] : undefined) ??
		SEARCH_URLS[host] ??
		SEARCH_URLS[host.replace(/^www\./, "")];
	return template ? fill(template, query) : null;
}

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
const CHALLENGE =
	/just a moment|verify you are human|checking your browser|attention required|are you a robot|unusual traffic|captcha|ロボットではありません|しばらくお待ちください.{0,20}確認/i;

export function isChallenge(title: string | undefined, body: string): boolean {
	if (title && CHALLENGE.test(title)) return true;
	// A real page that mentions a captcha somewhere is long; a challenge page is short.
	return body.length < 4000 && CHALLENGE.test(body);
}
