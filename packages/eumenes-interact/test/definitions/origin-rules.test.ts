import { describe, expect, test } from "bun:test";
import { checkHttpsUrl, originText } from "../../src/definitions/origin.ts";
import { grantOrigin } from "../../src/host/grants.ts";
import { isStorableOrigin } from "../../src/sqlite/validate.ts";

/**
 * One input table through the three origin readers (design R10; the differences are documented at the top of
 * `src/definitions/origin.ts`). A change in any column is a change of a layer's rule and must be meant.
 * Columns: definitions (`checkHttpsUrl`, the origin or the refusal), the stored form (`requireOrigin`), and a
 * grant's site (`grantOrigin`).
 */
const TABLE: [
	input: string,
	definition: string,
	stored: boolean,
	grant: string | null,
][] = [
	[
		"https://shop.example",
		"https://shop.example",
		true,
		"https://shop.example",
	],
	// Stored origins are normalized by the host first; the other two normalize themselves.
	[
		"https://Shop.Example",
		"https://shop.example",
		false,
		"https://shop.example",
	],
	[
		"https://shop.example:443",
		"https://shop.example",
		false,
		"https://shop.example",
	],
	[
		"https://shop.example:8443",
		"https://shop.example:8443",
		true,
		"https://shop.example:8443",
	],
	// Plain http: never a definition; stored for the lab's fixtures; a grant only on loopback.
	["http://shop.example", "url_not_https", true, null],
	["http://127.0.0.1:8080", "url_not_https", true, "http://127.0.0.1:8080"],
	// IP literals are no definition's origin (WHATWG reads 0x7f.0.0.1 as 127.0.0.1).
	["https://127.0.0.1", "url_invalid", true, "https://127.0.0.1"],
	// The stored form checks shape only: the host stores WHATWG's `https://127.0.0.1`, never this spelling.
	["https://0x7f.0.0.1", "url_invalid", true, "https://127.0.0.1"],
	["https://[::1]", "url_invalid", true, "https://[::1]"],
	// Names WHATWG accepts that the narrower readers refuse.
	["https://my_host.example", "url_invalid", false, "https://my_host.example"],
	["https://shop.example.", "url_invalid", false, "https://shop.example."],
	["https://例え.jp", "url_invalid", false, "https://xn--r8jz45g.jp"],
	[
		"https://xn--r8jz45g.jp",
		"https://xn--r8jz45g.jp",
		true,
		"https://xn--r8jz45g.jp",
	],
	// Userinfo is refused where it is read; WHATWG drops it from the origin (and `\` ends the host).
	["https://user@shop.example", "url_userinfo", false, "https://shop.example"],
	[
		"https://shop.example\\@evil.example",
		"url_userinfo",
		false,
		"https://shop.example",
	],
];

describe("origin readers (R10)", () => {
	for (const [input, definition, stored, grant] of TABLE)
		test(input, () => {
			const checked = checkHttpsUrl(input);
			expect(checked.ok ? originText(checked.origin) : checked.code).toBe(
				definition,
			);
			expect(isStorableOrigin(input)).toBe(stored);
			expect(grantOrigin(input)).toBe(grant);
		});
});
