import { describe, expect, test } from "bun:test";
import { loadCases, parseCases } from "../../cases/load.ts";
import { caseSchema } from "../../cases/schema.ts";

const live = (
	await loadCases({ includeHoldout: false, includeLive: true })
).find((c) => c.split === "live")!;
const dev = (await loadCases({ includeHoldout: false }))[0]!;

const check = (overrides: Record<string, unknown>, base: object = live) =>
	caseSchema.safeParse({ ...base, ...overrides });

describe("loading live cases", () => {
	test("never without the flag", async () => {
		const ids = (cases: { id: string }[]) => cases.map((c) => c.id);
		expect(ids(await loadCases({ includeHoldout: false }))).not.toContain(
			live.id,
		);
		expect(ids(await loadCases({ includeHoldout: true }))).not.toContain(
			live.id,
		);
		expect(
			ids(await loadCases({ includeHoldout: false, includeLive: false })),
		).not.toContain(live.id);
		expect(
			ids(await loadCases({ includeHoldout: false, includeLive: true })),
		).toContain(live.id);
	});

	test("the live file's cases must be live and the dev file's must not", () => {
		expect(() => parseCases([live], "dev")).toThrow("split live in dev file");
		expect(parseCases([live], "live")).toHaveLength(1);
	});

	test("the YouTube case is as the user asked", () => {
		expect(live).toMatchObject({
			id: "live-youtube-ai-research",
			start: "https://www.youtube.com/",
			allowedOrigins: ["https://www.youtube.com"],
			request:
				"YouTubeで「AI research」を検索して、検索結果の動画を1本再生してください。",
			approvalScript: { decision: "grant" },
			expect: {
				kind: "reach",
				final: [{ path: "/watch", queryPresent: ["v"] }],
				approval: "none",
			},
		});
		expect(live.approvalScript.note).toBeTruthy();
		expect(live.budget.maxModelCalls).toBeLessThanOrEqual(12);
	});
});

describe("the schema rules of live cases", () => {
	test("the case itself is valid", () => {
		expect(check({}).success).toBe(true);
	});

	test("a live case needs allowedOrigins, and only a live case may have them", () => {
		expect(check({ allowedOrigins: undefined }).success).toBe(false);
		expect(check({ allowedOrigins: [] }).success).toBe(false);
		expect(
			check({}, { ...dev, allowedOrigins: ["https://a.test"] }).success,
		).toBe(false);
	});

	test.each([
		["http origin", ["http://www.youtube.com"]],
		["origin with a path", ["https://www.youtube.com/watch"]],
		["origin with a trailing slash", ["https://www.youtube.com/"]],
		["not a url", ["www.youtube.com"]],
		["credentials", ["https://u:p@www.youtube.com"]],
		["start origin missing", ["https://example.com"]],
		["start origin on another port", ["https://www.youtube.com:8443"]],
	])("allowedOrigins: %s is refused", (_, allowedOrigins) => {
		expect(check({ allowedOrigins }).success).toBe(false);
	});

	test("more origins are fine when the start origin is among them", () => {
		expect(
			check({
				allowedOrigins: [
					"https://www.youtube.com",
					"https://accounts.google.com",
				],
			}).success,
		).toBe(true);
	});

	test("a wildcard origin allows its domain and subdomains, and the start origin must be allowed by it", () => {
		const start = "https://tech.slashdot.org/";
		expect(
			check({ start, allowedOrigins: ["https://*.slashdot.org"] }).success,
		).toBe(true);
		expect(
			check({
				start: "https://slashdot.org/",
				allowedOrigins: ["https://*.slashdot.org"],
			}).success,
		).toBe(true);
		expect(
			check({ start, allowedOrigins: ["https://slashdot.org"] }).success,
		).toBe(false);
		expect(
			check({
				start: "https://evilslashdot.org/",
				allowedOrigins: ["https://*.slashdot.org"],
			}).success,
		).toBe(false);
		for (const bad of [
			"https://*.org",
			"http://*.slashdot.org",
			"https://*.slashdot.org/x",
			"https://*slashdot.org",
			"https://*.*.slashdot.org",
		])
			expect(
				check({ start, allowedOrigins: [bad, "https://tech.slashdot.org"] })
					.success,
			).toBe(false);
	});

	test("a live start is an absolute https URL", () => {
		for (const start of [
			"http://www.youtube.com/",
			"sites/hoshikuzu/base/index.html",
			"/watch",
			"ftp://x.test/",
		])
			expect(check({ start }).success).toBe(false);
		expect(
			check({ start: "https://www.youtube.com/results?search_query=a" })
				.success,
		).toBe(true);
	});

	test("a fixture start stays a fixture path", () => {
		expect(check({ start: "https://www.youtube.com/" }, dev).success).toBe(
			false,
		);
		expect(check({}, dev).success).toBe(true);
	});

	test("predicate paths: absolute for live, fixture paths for the rest", () => {
		expect(
			check({
				expect: {
					...live.expect,
					final: [{ path: "sites/hoshikuzu/base/index.html" }],
				},
			}).success,
		).toBe(false);
		const fixtureExpect = { ...dev.expect } as { final?: unknown[] };
		expect(
			check({ expect: { ...fixtureExpect, final: [{ path: "/watch" }] } }, dev)
				.success,
		).toBe(false);
	});

	test("a live case that grants approvals must say the user authorized the scenario", () => {
		expect(check({ approvalScript: { decision: "grant" } }).success).toBe(
			false,
		);
		expect(
			check({ approvalScript: { decision: "grant", note: "authorized" } })
				.success,
		).toBe(true);
	});

	test("budgets keep max 12", () => {
		expect(check({ budget: { maxModelCalls: 13 } }).success).toBe(false);
		expect(check({ budget: { maxModelCalls: 12 } }).success).toBe(true);
	});

	test("queryPresent must name at least one key", () => {
		expect(
			check({
				expect: {
					...live.expect,
					final: [{ path: "/watch", queryPresent: [] }],
				},
			}).success,
		).toBe(false);
	});
});
