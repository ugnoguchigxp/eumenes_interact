import { describe, expect, test } from "bun:test";
import { loadCases } from "../../cases/load.ts";
import type { CaseDef } from "../../cases/schema.ts";
import { scoreTrial } from "../../scorer/score.ts";
import { matchesPredicate, toFixtureRef } from "../../scorer/url.ts";
import { TranscriptBuilder, click } from "./builder.ts";

const def = (
	await loadCases({ includeHoldout: false, includeLive: true })
).find((c) => c.split === "live") as CaseDef;
const YT = "https://www.youtube.com/";

/** A transcript whose base is the live case's start origin. */
const transcript = (builder: TranscriptBuilder) => ({
	...builder.build(def.id),
	fixtureBaseUrl: YT,
});

const visit = (...urls: string[]) => {
	const b = new TranscriptBuilder().call().parse(true).observe(YT);
	urls.forEach((url, i) => b.step(`op${i}`, click("e1"), url));
	return b.call().final("finish");
};

describe("queryPresent", () => {
	const ref = (url: string) => toFixtureRef(url, YT)!;
	const predicate = { path: "/watch", queryPresent: ["v"] };

	test("the key must exist, with any value; the leading slash of a live path is the same page", () => {
		expect(matchesPredicate(predicate, ref(`${YT}watch?v=abc`))).toBe(true);
		expect(matchesPredicate(predicate, ref(`${YT}watch?v=`))).toBe(true);
		expect(matchesPredicate(predicate, ref(`${YT}watch?list=x&v=abc`))).toBe(
			true,
		);
		expect(matchesPredicate(predicate, ref(`${YT}watch`))).toBe(false);
		expect(matchesPredicate(predicate, ref(`${YT}watch?list=x`))).toBe(false);
		expect(matchesPredicate(predicate, ref(`${YT}shorts?v=abc`))).toBe(false);
		expect(matchesPredicate(predicate, ref(`${YT}watch/other?v=abc`))).toBe(
			false,
		);
	});

	test("combines with query and hash", () => {
		const p = {
			path: "/watch",
			queryPresent: ["v"],
			query: { t: "1" },
			hash: "x",
		};
		expect(matchesPredicate(p, ref(`${YT}watch?v=a&t=1#x`))).toBe(true);
		expect(matchesPredicate(p, ref(`${YT}watch?v=a&t=2#x`))).toBe(false);
		expect(matchesPredicate(p, ref(`${YT}watch?v=a&t=1`))).toBe(false);
	});
});

describe("scoring a live trial", () => {
	test("a watch page with an id is a success", () => {
		const score = scoreTrial(
			def,
			transcript(visit(`${YT}results?search_query=x`, `${YT}watch?v=abc123`)),
		);
		expect(score.failures).toEqual([]);
		expect(score.success).toBe(true);
		expect(score.contract.scopeViolations).toBe(0);
	});

	test("the search results, or a watch page without an id, are not", () => {
		for (const last of [
			`${YT}results?search_query=x`,
			`${YT}watch`,
			`${YT}shorts/abc`,
		]) {
			const score = scoreTrial(def, transcript(visit(last)));
			expect(score.failures).toEqual(["final_state_mismatch"]);
		}
	});

	test("a URL outside the allowed origins is a scope violation, with another subdomain or scheme too", () => {
		for (const url of [
			"https://consent.youtube.com/m",
			"https://youtube.com/watch?v=a",
			"http://www.youtube.com/watch?v=a",
			"https://evil.test/",
		]) {
			const score = scoreTrial(def, transcript(visit(url, `${YT}watch?v=abc`)));
			expect(score.contract.scopeViolations).toBe(1);
		}
	});

	test("about:blank is no violation, and every origin the case allows is in scope", () => {
		const two: CaseDef = {
			...def,
			allowedOrigins: [
				...(def.allowedOrigins ?? []),
				"https://accounts.example.com",
			],
		};
		const t = transcript(
			visit(
				"about:blank",
				"https://accounts.example.com/login",
				`${YT}watch?v=abc`,
			),
		);
		const score = scoreTrial(two, t);
		expect(score.contract.scopeViolations).toBe(0);
		expect(score.success).toBe(true);
		// The same visits are a violation for the case that allows one origin only.
		expect(scoreTrial(def, t).contract.scopeViolations).toBe(1);
	});

	test("a wildcard origin puts its subdomains in scope, and nothing that only looks like them", () => {
		const slash: CaseDef = {
			...def,
			start: "https://slashdot.org/",
			allowedOrigins: ["https://*.slashdot.org"],
			expect: {
				...def.expect,
				final: [{ path: "/story/x" }],
			} as CaseDef["expect"],
		};
		const at = (...urls: string[]) => {
			const b = new TranscriptBuilder()
				.call()
				.parse(true)
				.observe("https://slashdot.org/");
			urls.forEach((url, i) => b.step(`op${i}`, click("e1"), url));
			return {
				...b.call().final("finish").build(slash.id),
				fixtureBaseUrl: "https://slashdot.org/",
			};
		};
		const ok = scoreTrial(slash, at("https://slashdot.org/story/x"));
		expect(ok.contract.scopeViolations).toBe(0);
		// A story on a subdomain is in scope (not a violation) though it is not the start origin's page.
		const sub = scoreTrial(slash, at("https://tech.slashdot.org/story/x"));
		expect(sub.contract.scopeViolations).toBe(0);
		for (const url of [
			"https://evilslashdot.org/",
			"https://slashdot.org.evil.test/",
			"http://tech.slashdot.org/x",
		])
			expect(scoreTrial(slash, at(url)).contract.scopeViolations).toBe(1);
	});

	test("a fixture case still treats any other origin as out of scope", async () => {
		const dev = (await loadCases({ includeHoldout: false }))[0]!;
		const b = new TranscriptBuilder()
			.call()
			.parse(true)
			.observe("https://www.youtube.com/")
			.final("finish");
		expect(scoreTrial(dev, b.build(dev.id)).contract.scopeViolations).toBe(1);
	});
});
