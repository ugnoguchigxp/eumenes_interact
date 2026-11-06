import { describe, expect, test } from "bun:test";
import { ancestors, parseNodes, refsOf } from "eumenes-interact";
import { resolveCandidate, resolveObject } from "../../host/candidates.ts";
import { runDefinition } from "../../host/definition-run.ts";
import { readDefinition } from "../../host/definitions.ts";
import { silentLabLogger } from "../../host/log.ts";
import { importSeed, readSeed } from "../../knowledge/seed.ts";
import { LAB_OWNER } from "../../host/run.ts";
import { listOperations } from "eumenes-interact/sqlite";
import { FakeBrowser, toInlineAttributes } from "./fake-adapter.ts";
import { freshDb, runScripted, devCase } from "./harness.ts";

/** The same page in both spellings the parser reads. */
const PLAYWRIGHT = [
	"- banner [ref=e1]:",
	'  - searchbox "Wikipedia内を検索" [ref=e2]',
	'  - link "ホーム" [ref=e3]:',
	"    - /url: /wiki/Main",
	"- main [ref=e4]:",
	'  - link "ヘルプ" [ref=e5]:',
	"    - /url: /wiki/Help:%E6%A4%9C%E7%B4%A2",
	'  - link "特別" [ref=e6]:',
	"    - /url: /wiki/%E7%89%B9%E5%88%A5:%E6%A4%9C%E7%B4%A2",
	"  - link [ref=e7]:",
	"    - /url: /wiki/Thumb",
	'  - link "機械学習" [ref=e8]:',
	"    - /url: /wiki/%E6%A9%9F",
	'  - link "人工知能" [ref=e9]:',
	"    - /url: /wiki/AI",
	'  - radio "小" [checked=false, ref=e10]',
	"- contentinfo [ref=e11]:",
	'  - link "規約" [ref=e12]:',
	"    - /url: /wiki/Terms",
].join("\n");

/** The inline spelling: one bracket of attributes, the destination inside it, no child url lines. */
const INLINE = [
	"- banner [ref=e1]",
	'  - searchbox "Wikipedia内を検索" [ref=e2]',
	'  - link "ホーム" [ref=e3, url=/wiki/Main]',
	"- main [ref=e4]",
	'  - link "ヘルプ" [ref=e5, url=/wiki/Help:%E6%A4%9C%E7%B4%A2]',
	'  - link "特別" [ref=e6, url=/wiki/%E7%89%B9%E5%88%A5:%E6%A4%9C%E7%B4%A2]',
	"  - link [ref=e7, url=/wiki/Thumb]",
	'  - link "機械学習" [ref=e8, url=/wiki/%E6%A9%9F]',
	'  - link "人工知能" [ref=e9, url=/wiki/AI]',
	'  - radio "小" [checked=false, ref=e10]',
	"- contentinfo [ref=e11]",
	'  - link "規約" [ref=e12, url=/wiki/Terms]',
].join("\n");

const BODIES = { playwright: PLAYWRIGHT, inline: INLINE } as const;
type Fields = Record<string, string | number | boolean>;
const refOf = (body: string, kind: string, fields: Fields) => {
	const r = resolveCandidate(body, { kind: kind as never, fields });
	return r.kind === "found" ? r.match.ref : r.kind;
};

describe("the two snapshot spellings", () => {
	test("the converter used by the tests gives the inline spelling", () => {
		expect(toInlineAttributes(PLAYWRIGHT)).toBe(INLINE);
	});

	test("refs, names, roles, ancestry and destinations read the same from both", () => {
		const nodes = (body: string) => {
			const parsed = parseNodes(body);
			return parsed.map((node) => [
				node.role,
				node.name === "" ? null : node.name,
				node.ref,
				node.url,
				ancestors(parsed, node)
					.map((parent) => parent.role)
					.reverse(),
			]);
		};
		expect(nodes(INLINE)).toEqual(nodes(PLAYWRIGHT));
		expect(refsOf(INLINE)).toEqual(refsOf(PLAYWRIGHT));
		expect(refsOf(INLINE)).toEqual([
			"e1",
			"e2",
			"e3",
			"e4",
			"e5",
			"e6",
			"e7",
			"e8",
			"e9",
			"e10",
			"e11",
			"e12",
		]);
	});

	test("an inline attribute list: ref anywhere in it, a URL with commas, an escaped quote in a name", () => {
		const body = [
			'- radio "小" [checked=false, ref=e322]',
			'- link "寄付" [ref=e27, url=https://donate.wikimedia.org/?a=1,2&b=3]',
			'- button "He said \\"hi\\"" [disabled, ref=e5]',
			"- heading [level=1, ref=e6]",
		].join("\n");
		const [radio, link, button, heading] = parseNodes(body);
		expect(radio).toMatchObject({
			role: "radio",
			name: "小",
			ref: "e322",
			url: null,
		});
		expect(link).toMatchObject({
			ref: "e27",
			url: "https://donate.wikimedia.org/?a=1,2&b=3",
		});
		expect(button).toMatchObject({ name: 'He said "hi"', ref: "e5" });
		expect(heading).toMatchObject({ role: "heading", name: "", ref: "e6" });
		expect(refsOf(body)).toEqual(["e322", "e27", "e5", "e6"]);
		// Text that merely looks like a ref is not one.
		expect(refsOf("- text: see ref=e9 and [x]")).toEqual([]);
	});

	describe.each(["playwright", "inline"] as const)(
		"candidate fields on a %s body",
		(format) => {
			const body = BODIES[format];
			const named = {
				role: "link",
				withinRole: "main",
				named: "true",
				urlIncludes: "/wiki/",
			};

			test("role with name, and nameAnyOf a|b", () => {
				expect(
					refOf(body, "role", { role: "searchbox", name: "Wikipedia内を検索" }),
				).toBe("e2");
				expect(refOf(body, "role", { role: "searchbox", name: "別" })).toBe(
					"none",
				);
				expect(
					refOf(body, "role", { role: "link", nameAnyOf: "ホーム|Home" }),
				).toBe("e3");
				expect(
					refOf(body, "role", { role: "link", nameAnyOf: "ない|Nothing" }),
				).toBe("none");
				expect(refOf(body, "role", { role: "main" })).toBe("e4");
			});

			test("named, urlIncludes, urlExcludes (also against the decoded address)", () => {
				expect(
					refOf(body, "structure", { ...named, urlIncludes: "/wiki/Thumb" }),
				).toBe("none");
				expect(
					refOf(body, "structure", {
						role: "link",
						withinRole: "main",
						urlIncludes: "/wiki/Thumb",
					}),
				).toBe("e7");
				expect(
					refOf(body, "structure", {
						...named,
						urlExcludes: "/wiki/Help:|/wiki/特別:",
						nth: 0,
					}),
				).toBe("e8");
				expect(refOf(body, "structure", { ...named, nth: 0 })).toBe("e5");
				expect(
					refOf(body, "structure", {
						...named,
						urlIncludes: "特別:",
						urlExcludes: "x",
					}),
				).toBe("e6");
			});

			test("withinRole by indentation, nth, and ambiguity without it", () => {
				expect(
					refOf(body, "structure", {
						role: "link",
						withinRole: "main",
						urlIncludes: "/wiki/AI",
					}),
				).toBe("e9");
				expect(
					refOf(body, "structure", {
						role: "link",
						withinRole: "banner",
						urlIncludes: "/wiki/AI",
					}),
				).toBe("none");
				expect(
					refOf(body, "structure", {
						role: "link",
						withinRole: "contentinfo",
						urlIncludes: "/wiki/",
					}),
				).toBe("e12");
				expect(
					refOf(body, "structure", {
						role: "link",
						withinRole: "main",
						named: "true",
					}),
				).toBe("ambiguous");
				expect(refOf(body, "structure", { ...named, nth: "3" })).toBe("e9");
				expect(refOf(body, "structure", { ...named, nth: 9 })).toBe("none");
			});

			test("a radio with attributes before the ref", () => {
				expect(refOf(body, "role", { role: "radio", name: "小" })).toBe("e10");
			});

			test("the object resolver gives the same element for the same candidates", () => {
				const candidate = (id: number, fields: Fields) => ({
					id,
					objectId: 1,
					kind: "structure" as const,
					fields,
					status: "candidate" as const,
					statusReason: null,
					statusChangedAt: "2026-11-03T00:00:00.000Z",
					source: { adapter: "playwright-mcp" as const, via: "snapshot" },
					addedRevision: 1,
					createdAt: "2026-11-03T00:00:00.000Z",
				});
				expect(
					resolveObject(body, [
						candidate(1, {
							...named,
							urlExcludes: "/wiki/Help:|/wiki/特別:",
							nth: 0,
						}),
					]),
				).toMatchObject({
					kind: "found",
					match: { ref: "e8", name: "機械学習" },
				});
			});
		},
	);
});

describe("a run on a page in the inline spelling", () => {
	const wiki = readDefinition(
		`${import.meta.dir}/../../definitions/wikipedia-article.json`,
	);
	const seed = readSeed(`${import.meta.dir}/../../knowledge/wikipedia.json`);
	const inline = () => new FakeBrowser({ format: "inline" });

	test("the Wikipedia definition runs end to end, and the result names the platform and the tool", async () => {
		const db = freshDb();
		importSeed(db, LAB_OWNER, await seed, "2026-11-03T00:00:00.000Z");
		const adapter = inline();
		const r = await runDefinition({
			db,
			definition: await wiki,
			inputs: { query: "人工知能" },
			adapter,
			logger: silentLabLogger,
		});
		expect(r.status).toBe("completed");
		expect(r.platform).toBe("playwright-mcp");
		expect(r.tool).toEqual({ name: "fake-playwright", version: "0.0.0" });
		// The first named /wiki/ link of the results is the right one in this spelling too.
		expect(
			adapter.dispatched.find((c) => c.action === "page.click"),
		).toMatchObject({ targetRef: "e8" });
		expect(["target", "main"]).toContain(r.extracts.read?.root ?? "");
		const row = db
			.query("SELECT platform, tool_json FROM lab_definition_runs")
			.get() as { platform: string; tool_json: string };
		expect(row.platform).toBe("playwright-mcp");
		expect(JSON.parse(row.tool_json)).toEqual({
			name: "fake-playwright",
			version: "0.0.0",
		});
		expect(
			listOperations(db, LAB_OWNER, r.runId!).every(
				(o) => o.status === "confirmed",
			),
		).toBe(true);
	});

	test("a dev case runs on it too: the scripted flow, the core and the scorer", async () => {
		const def = await devCase("dev-search-base");
		const { result } = await runScripted(def.id, { adapter: inline() });
		expect(result.status).toBe("completed");
		expect(result.score.success).toBe(true);
		const observed = result.transcript.events.flatMap((e) =>
			e.type === "observation" ? [e] : [],
		);
		expect(observed.length).toBeGreaterThan(0);
		for (const e of observed) {
			expect(e.bodyBytes).toBeGreaterThan(0);
			expect(e.shapedBytes).toBeGreaterThan(0);
			expect(e.shapedBytes).toBeLessThanOrEqual(e.bodyBytes!);
			expect(e.refCount).toBeGreaterThan(0);
		}
	});
});
