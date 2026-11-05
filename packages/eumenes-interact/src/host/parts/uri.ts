/**
 * An address as the browser must receive it: an IRI (non-ASCII path, query or host, e.g. 「天気」 in a
 * query) becomes its URI form — percent-encoded UTF-8, the host in punycode. Escapes already present stay.
 * A non-ASCII address sent as is lost the tab (L10, 2026-11-05). Not an absolute URL: returned unchanged,
 * so the URL policy still sees and refuses it.
 */
export function toUri(url: string): string {
	if (![...url].some((c) => c.charCodeAt(0) > 0x7f)) return url;
	try {
		return new URL(url).href;
	} catch {
		return url;
	}
}
