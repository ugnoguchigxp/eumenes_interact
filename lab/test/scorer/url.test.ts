import { describe, expect, test } from "bun:test";
import { matchesPredicate, toFixtureRef } from "../../scorer/url.ts";
import { BASE_URL } from "./builder.ts";

describe("toFixtureRef", () => {
	test("resolves a URL under the base and decodes query and fragment", () => {
		const ref = toFixtureRef(
			`${BASE_URL}sites/a/b/results.html?q=%E7%99%BD%E6%B3%A2#x`,
			BASE_URL,
		);
		expect(ref?.path).toBe("sites/a/b/results.html");
		expect(ref?.query.get("q")).toBe("白波");
		expect(ref?.hash).toBe("x");
	});

	test("rejects another host, another port, another scheme and another prefix", () => {
		const path = "sites/a/b/index.html";
		expect(toFixtureRef(`http://evil.example/${path}`, BASE_URL)).toBeNull();
		expect(toFixtureRef(`http://127.0.0.1:43211/${path}`, BASE_URL)).toBeNull();
		expect(
			toFixtureRef(`https://127.0.0.1:43210/${path}`, BASE_URL),
		).toBeNull();
		expect(toFixtureRef(`file:///${path}`, BASE_URL)).toBeNull();
		expect(toFixtureRef("not a url", BASE_URL)).toBeNull();
		expect(
			toFixtureRef(`${BASE_URL}other/${path}`, `${BASE_URL}sites/`),
		).toBeNull();
	});
});

describe("matchesPredicate", () => {
	const ref = toFixtureRef(
		`${BASE_URL}sites/a/b/p.html?x=%EF%BC%91&y=2#h`,
		BASE_URL,
	);
	test("path equal, query entries equal after NFKC, extra query allowed, hash equal", () => {
		if (!ref) throw new Error("ref");
		expect(matchesPredicate({ path: "sites/a/b/p.html" }, ref)).toBe(true);
		expect(
			matchesPredicate({ path: "sites/a/b/p.html", query: { x: "1" } }, ref),
		).toBe(true);
		expect(
			matchesPredicate({ path: "sites/a/b/p.html", query: { x: "2" } }, ref),
		).toBe(false);
		expect(matchesPredicate({ path: "sites/a/b/p.html", hash: "h" }, ref)).toBe(
			true,
		);
		expect(matchesPredicate({ path: "sites/a/b/p.html", hash: "g" }, ref)).toBe(
			false,
		);
		expect(matchesPredicate({ path: "sites/a/b/q.html" }, ref)).toBe(false);
	});
});
