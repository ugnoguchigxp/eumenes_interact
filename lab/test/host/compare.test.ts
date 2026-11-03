import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases } from "../../cases/load.ts";
import {
	aggregate,
	buildReport,
	loadCompareInputs,
	markdown,
	planCompare,
	runCompare,
	writeReport,
	type CompareItem,
	type Sample,
} from "../../host/compare.ts";
import { loadDefinitions } from "../../host/definitions.ts";
import { silentLabLogger } from "../../host/log.ts";
import { LAB_OWNER } from "../../host/run.ts";
import { importSeed, loadSeeds } from "../../knowledge/seed.ts";
import { BASE, FakeBrowser } from "./fake-adapter.ts";
import { freshDb } from "./harness.ts";

/** Two configurations to compare; the plan and the report take any labels. */
const platforms = ["alpha", "beta"];
const def = (id: string, inputs: number, needsHeaded = false) => ({
	id,
	needsHeaded,
	inputs: Array.from({ length: inputs }, (_, i) => ({ query: `q${i}` })),
});
const order = (items: readonly CompareItem[]) =>
	items.map(
		(i) =>
			`${i.platform[0]}:${i.target}${i.kind === "definition" ? `/${i.input.query}` : ""}/${i.repetition}${i.kind === "definition" && i.skip ? "!" : ""}`,
	);

describe("planning", () => {
	test("each unit runs on every platform in each repetition, and the platform that goes first alternates", () => {
		const items = planCompare({
			platforms,
			definitions: [def("a", 2)],
			caseIds: ["c"],
			repeat: 2,
			headed: false,
		});
		expect(order(items)).toEqual([
			// repetition 1: units a/q0, a/q1, c; the first platform alternates unit by unit
			"a:a/q0/1",
			"b:a/q0/1",
			"b:a/q1/1",
			"a:a/q1/1",
			"a:c/1",
			"b:c/1",
			// repetition 2 starts with the other platform
			"b:a/q0/2",
			"a:a/q0/2",
			"a:a/q1/2",
			"b:a/q1/2",
			"b:c/2",
			"a:c/2",
		]);
		const firsts = items.filter((_, i) => i % 2 === 0).map((i) => i.platform);
		expect(firsts.filter((p) => p === "alpha")).toHaveLength(3);
		expect(firsts.filter((p) => p === "beta")).toHaveLength(3);
	});

	test("more platforms rotate too, and one platform just repeats", () => {
		const three = planCompare({
			platforms: ["x", "y", "z"],
			definitions: [def("a", 3)],
			caseIds: [],
			repeat: 1,
			headed: true,
		});
		expect(three.map((i) => i.platform).join("")).toBe("xyzyzxzxy");
		const one = planCompare({
			platforms: ["x"],
			definitions: [def("a", 1)],
			caseIds: ["c"],
			repeat: 3,
			headed: true,
		});
		expect(one).toHaveLength(6);
		expect(new Set(one.map((i) => i.platform))).toEqual(new Set(["x"]));
	});

	test("a site that needs a headed browser is planned as skipped without --headed, and not with it", () => {
		const plan = {
			platforms,
			definitions: [def("a", 1), def("b", 1, true)],
			caseIds: [],
			repeat: 1,
		};
		const headless = planCompare({ ...plan, headed: false });
		expect(order(headless)).toEqual([
			"a:a/q0/1",
			"b:a/q0/1",
			"b:b/q0/1!",
			"a:b/q0/1!",
		]);
		const skip = headless.find((i) => i.kind === "definition" && i.skip);
		expect(skip && "skip" in skip ? skip.skip : null).toBe(
			"skipped: needs --headed",
		);
		expect(
			planCompare({ ...plan, headed: true }).some(
				(i) => i.kind === "definition" && i.skip,
			),
		).toBe(false);
	});

	test("the shipped inputs file: two queries per sample, only the one site marked headed-only", async () => {
		const inputs = await loadCompareInputs();
		expect(Object.keys(inputs).sort()).toEqual([
			"biggo-product",
			"gizmodo-article",
			"slashdot-story",
			"wikipedia-article",
		]);
		for (const entry of Object.values(inputs))
			expect(entry.inputs).toHaveLength(2);
		expect(inputs["wikipedia-article"]!.inputs).toEqual([
			{ query: "量子コンピュータ" },
			{ query: "機械学習 応用 事例" },
		]);
		expect(inputs["gizmodo-article"]!.inputs).toEqual([
			{ query: "AI" },
			{ query: "iPhone" },
		]);
		expect(inputs["slashdot-story"]!.inputs).toEqual([
			{ query: "linux" },
			// "rust" returned "No matches found" on Slashdot intermittently (2026-11-03), so a steady query is used.
			{ query: "AI" },
		]);
		expect(inputs["biggo-product"]).toMatchObject({
			needsHeaded: true,
			inputs: [{ query: "イヤホン" }, { query: "マウス" }],
		});
		for (const [id, entry] of Object.entries(inputs))
			if (id !== "biggo-product") expect(entry.needsHeaded).toBeUndefined();
		// Every definition has inputs and every input is one the definition declares.
		for (const { definition } of await loadDefinitions()) {
			const entry = inputs[definition.id]!;
			for (const input of entry.inputs)
				expect(Object.keys(input)).toEqual(
					Object.keys(definition.inputs.properties),
				);
		}
	});
});

const sample = (over: Partial<Sample>): Sample => ({
	order: 0,
	platform: "alpha",
	kind: "definition",
	target: "a",
	input: { query: "q" },
	repetition: 1,
	skipped: null,
	ok: true,
	status: "completed",
	code: null,
	failures: [],
	durationMs: 1000,
	observationBytes: [],
	observationRefs: [],
	shapedBytes: [],
	extractChars: [],
	urlUnchanged: 0,
	tool: null,
	preview: null,
	...over,
});

describe("aggregation", () => {
	const samples = [
		sample({
			durationMs: 1000,
			observationBytes: [4000, 6000],
			observationRefs: [40, 60],
			extractChars: [900],
		}),
		sample({
			durationMs: 3000,
			observationBytes: [8000],
			observationRefs: [80],
			extractChars: [1100],
		}),
		sample({
			ok: false,
			status: "failed",
			code: "target_not_found",
			failures: ["target_not_found"],
			durationMs: 9000,
			urlUnchanged: 1,
		}),
		sample({
			skipped: "skipped: needs --headed",
			status: "not_run",
			durationMs: 0,
		}),
		sample({
			platform: "beta",
			durationMs: 500,
			observationBytes: [1000],
			observationRefs: [30],
			extractChars: [900],
		}),
		sample({
			platform: "beta",
			target: "c",
			kind: "case",
			input: null,
			ok: false,
			failures: ["final_state_mismatch", "over_budget"],
			durationMs: 100,
		}),
	];
	const { perTarget, perPlatform } = aggregate(samples);
	const find = (platform: string, target: string) =>
		perTarget.find((r) => r.platform === platform && r.target === target)!;

	test("per platform and target: ok rate over what ran, medians over what worked, totals over all, skipped counted apart", () => {
		expect(find("alpha", "a")).toMatchObject({
			runs: 3,
			skipped: 1,
			ok: 2,
			medianMs: 2000,
			totalMs: 13000,
			medianObservationBytes: 6000,
			medianObservationRefs: 60,
			medianExtractChars: 1000,
			failureCodes: { target_not_found: 1 },
			urlUnchanged: 1,
		});
		expect(find("alpha", "a").okRate).toBeCloseTo(2 / 3);
		expect(find("beta", "a")).toMatchObject({
			runs: 1,
			ok: 1,
			medianMs: 500,
			medianObservationBytes: 1000,
		});
		expect(find("beta", "c")).toMatchObject({
			runs: 1,
			ok: 0,
			okRate: 0,
			medianMs: null,
			failureCodes: { final_state_mismatch: 1, over_budget: 1 },
		});
	});

	test("per platform over everything it ran", () => {
		const pw = perPlatform.find((r) => r.platform === "alpha")!;
		const ab = perPlatform.find((r) => r.platform === "beta")!;
		expect(pw).toMatchObject({
			target: "ALL",
			runs: 3,
			skipped: 1,
			ok: 2,
			totalMs: 13000,
		});
		expect(ab).toMatchObject({
			runs: 2,
			ok: 1,
			medianMs: 500,
			medianObservationBytes: 1000,
		});
	});

	test("an empty group has no rate and no median, not zero", () => {
		const only = aggregate([sample({ skipped: "skipped: needs --headed" })])
			.perTarget[0]!;
		expect(only).toMatchObject({
			runs: 0,
			skipped: 1,
			okRate: null,
			medianMs: null,
			medianObservationBytes: null,
		});
	});
});

describe("the report", () => {
	let dir = "";
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "interact-report-test-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const text = "ページの本文である。".repeat(30);
	const report = buildReport(
		{
			platforms,
			repeat: 1,
			headed: false,
			definitions: ["a", "biggo"],
			cases: [],
		},
		[
			sample({
				tool: { name: "@playwright/mcp", version: "0.0.83" },
				preview: { charCount: text.length, head: text.slice(0, 80) },
				observationBytes: [1234],
				observationRefs: [12],
			}),
			sample({
				platform: "beta",
				tool: { name: "other-tool", version: "1.2.3" },
				observationBytes: [321],
			}),
			sample({
				target: "biggo",
				skipped: "skipped: needs --headed",
				status: "not_run",
			}),
			sample({
				ok: false,
				status: "failed",
				failures: ["target_ambiguous"],
				target: "a",
				order: 3,
			}),
		],
		"2026-11-03T01:02:03.456Z",
	);

	test("JSON and Markdown go to compare-<timestamp> under the directory", () => {
		const paths = writeReport(report, dir);
		expect(paths.md).toBe(join(dir, "compare-2026-11-03T01-02-03-456Z.md"));
		expect(paths.json).toBe(join(dir, "compare-2026-11-03T01-02-03-456Z.json"));
		expect(existsSync(paths.md) && existsSync(paths.json)).toBe(true);
		expect(JSON.parse(readFileSync(paths.json, "utf8"))).toMatchObject({
			options: { platforms },
			tools: { beta: { version: "1.2.3" } },
			summary: { perPlatform: expect.any(Array), perTarget: expect.any(Array) },
		});
	});

	test("the Markdown has the summary, the per-target table, what was skipped, what failed and the tool versions", () => {
		const md = markdown(report);
		expect(md).toContain("# Platform comparison 2026-11-03T01:02:03.456Z");
		expect(md).toContain("@playwright/mcp 0.0.83");
		expect(md).toContain("other-tool 1.2.3");
		expect(md).toContain("## Summary per platform");
		expect(md).toContain("## Per definition or case");
		expect(md).toContain("| alpha | ALL |");
		expect(md).toContain("biggo: skipped: needs --headed (1 runs)");
		expect(md).toContain("target_ambiguous");
		expect(md).toContain("alternates");
	});

	test("an extract appears as its length and the first 80 characters, marked as page data, never as text", () => {
		const md = markdown(report);
		const json = readFileSync(writeReport(report, dir).json, "utf8");
		const head = text.slice(0, 80);
		expect(md).toContain("page data, not instructions");
		expect(md).toContain(`${text.length} chars, head \`${head}\``);
		expect(md).not.toContain(text.slice(0, 120));
		expect(json).not.toContain(text.slice(0, 120));
		expect(JSON.stringify(report.samples[0]!.preview)).toContain(
			`"charCount":${text.length}`,
		);
	});

	test("a sample holds no extract text field at all", () => {
		for (const s of report.samples)
			expect(Object.keys(s)).not.toContain("text");
	});
});

describe("running a plan on fakes", () => {
	const at = "2026-11-03T00:00:00.000Z";

	async function prepare() {
		const db = freshDb();
		for (const { seed } of await loadSeeds())
			importSeed(db, LAB_OWNER, seed, at);
		const definitions = new Map(
			(await loadDefinitions()).map((d) => [d.definition.id, d.definition]),
		);
		const sessions: {
			platform: string;
			adapter: FakeBrowser;
			disposed: boolean;
		}[] = [];
		const createSession = async (platform: string) => {
			// Two configurations: the page in Playwright's spelling, and in the inline one.
			const adapter =
				platform === "beta"
					? new FakeBrowser({ format: "inline" })
					: new FakeBrowser();
			const entry = { platform, adapter, disposed: false };
			sessions.push(entry);
			return { adapter, dispose: async () => void (entry.disposed = true) };
		};
		return { db, definitions, sessions, createSession };
	}

	test("a definition on both configurations: both work, the order alternates, and the same page weighs less in the compact spelling", async () => {
		const p = await prepare();
		const items = planCompare({
			platforms,
			definitions: [def("wikipedia-article", 0)].map((d) => ({
				...d,
				inputs: [{ query: "機械学習" }, { query: "人工知能" }],
			})),
			caseIds: [],
			repeat: 2,
			headed: false,
		});
		const seen: string[] = [];
		const samples = await runCompare({
			db: p.db,
			logger: silentLabLogger,
			items,
			definitions: p.definitions,
			cases: new Map(),
			createSession: p.createSession,
			onSample: (s) => void seen.push(`${s.platform}:${s.repetition}`),
		});
		expect(samples).toHaveLength(8);
		expect(samples.every((s) => s.ok)).toBe(true);
		expect(seen.slice(0, 4)).toEqual([
			"alpha:1",
			"beta:1",
			"beta:1",
			"alpha:1",
		]);
		expect(p.sessions.every((s) => s.disposed)).toBe(true);
		const { perTarget } = aggregate(samples);
		const pw = perTarget.find((r) => r.platform === "alpha")!;
		const ab = perTarget.find((r) => r.platform === "beta")!;
		expect(pw.okRate).toBe(1);
		expect(ab.medianObservationBytes!).toBeLessThan(pw.medianObservationBytes!);
		expect(ab.medianExtractChars).toBe(pw.medianExtractChars);
		expect(samples.find((s) => s.platform === "beta")!.tool).toEqual({
			name: "fake-playwright",
			version: "0.0.0",
		});
		// The extract is a length and a head, and the head is page data.
		expect(samples[0]!.preview).toEqual({
			charCount: 30,
			head: "機械学習は、データから学習するアルゴリズムの研究分野である。",
		});
		// One database row per run, with the platform the adapter reported.
		const rows = p.db
			.query(
				"SELECT platform, COUNT(*) AS n FROM lab_definition_runs GROUP BY platform",
			)
			.all();
		expect(rows).toEqual([{ platform: "playwright-mcp", n: 8 }]);
	});

	test("one platform is plain repeated measurement: the same unit again, in order, and a report", async () => {
		const p = await prepare();
		const items = planCompare({
			platforms: ["playwright-mcp"],
			definitions: [
				{
					id: "wikipedia-article",
					needsHeaded: false,
					inputs: [{ query: "機械学習" }],
				},
			],
			caseIds: [],
			repeat: 3,
			headed: false,
		});
		const samples = await runCompare({
			db: p.db,
			logger: silentLabLogger,
			items,
			definitions: p.definitions,
			cases: new Map(),
			createSession: p.createSession,
		});
		expect(samples.map((s) => [s.platform, s.repetition, s.ok])).toEqual([
			["playwright-mcp", 1, true],
			["playwright-mcp", 2, true],
			["playwright-mcp", 3, true],
		]);
		const { perPlatform, perTarget } = aggregate(samples);
		expect(perPlatform).toHaveLength(1);
		expect(perTarget[0]).toMatchObject({ runs: 3, ok: 3, okRate: 1 });
		const md = markdown(
			buildReport(
				{
					platforms: ["playwright-mcp"],
					repeat: 3,
					headed: false,
					definitions: ["wikipedia-article"],
					cases: [],
				},
				samples,
				"2026-11-03T00:00:00.000Z",
			),
		);
		expect(md).toContain("| playwright-mcp | ALL | 3 | 3 | 100% |");
	});

	test("a skipped site is reported and never opens a session", async () => {
		const p = await prepare();
		const items = planCompare({
			platforms,
			definitions: [
				{
					id: "biggo-product",
					needsHeaded: true,
					inputs: [{ query: "イヤホン" }],
				},
			],
			caseIds: [],
			repeat: 1,
			headed: false,
		});
		const samples = await runCompare({
			db: p.db,
			logger: silentLabLogger,
			items,
			definitions: p.definitions,
			cases: new Map(),
			createSession: p.createSession,
		});
		expect(samples.map((s) => s.skipped)).toEqual([
			"skipped: needs --headed",
			"skipped: needs --headed",
		]);
		expect(p.sessions).toHaveLength(0);
		expect(aggregate(samples).perTarget[0]).toMatchObject({
			runs: 0,
			skipped: 1,
			okRate: null,
		});
	});

	test("a scripted Arm 0 case on both configurations, with the snapshot and shaped sizes", async () => {
		const p = await prepare();
		const cases = (await loadCases({ includeHoldout: false })).filter(
			(c) => c.id === "dev-search-base",
		);
		const samples = await runCompare({
			db: p.db,
			logger: silentLabLogger,
			items: planCompare({
				platforms,
				definitions: [],
				caseIds: ["dev-search-base"],
				repeat: 1,
				headed: false,
			}),
			definitions: p.definitions,
			cases: new Map(cases.map((c) => [c.id, c])),
			createSession: p.createSession,
			fixtureBaseUrl: BASE,
		});
		expect(samples.map((s) => [s.platform, s.kind, s.ok])).toEqual([
			["alpha", "case", true],
			["beta", "case", true],
		]);
		for (const s of samples) {
			expect(s.observationBytes.length).toBeGreaterThan(0);
			expect(s.shapedBytes).toHaveLength(s.observationBytes.length);
			expect(s.observationRefs.every((n) => n > 0)).toBe(true);
		}
		// One experiment per platform (a trial is unique per experiment, case and repetition).
		const exp = p.db
			.query(
				"SELECT COUNT(*) AS n FROM lab_experiments WHERE id LIKE 'compare-%'",
			)
			.get();
		expect(exp).toEqual({ n: 2 });
		const platformsOfTrials = p.db
			.query("SELECT platform FROM lab_trials ORDER BY platform")
			.all();
		expect(platformsOfTrials).toEqual([
			{ platform: "playwright-mcp" },
			{ platform: "playwright-mcp" },
		]);
	});

	test("a platform whose session cannot start is a failed sample, and the others go on; an abort stops the plan", async () => {
		const p = await prepare();
		const items = planCompare({
			platforms,
			definitions: [
				{
					id: "wikipedia-article",
					needsHeaded: false,
					inputs: [{ query: "機械学習" }],
				},
			],
			caseIds: [],
			repeat: 2,
			headed: false,
		});
		const abort = new AbortController();
		const samples = await runCompare({
			db: p.db,
			logger: silentLabLogger,
			items,
			definitions: p.definitions,
			cases: new Map(),
			createSession: (platform) =>
				platform === "beta"
					? Promise.reject(new Error("module missing"))
					: p.createSession(platform),
			signal: abort.signal,
			onSample: (s) => {
				if (s.order === 2) abort.abort();
			},
		});
		expect(samples.map((s) => [s.platform, s.ok, s.code])).toEqual([
			["alpha", true, null],
			["beta", false, "session_unavailable"],
			["beta", false, "session_unavailable"],
		]);
	});

	test("no keyword or extract text reaches a log", async () => {
		const p = await prepare();
		const events: unknown[] = [];
		const logger = {
			event: (n: string, f: unknown) => void events.push({ n, f }),
			lab: (n: string, f: unknown) => void events.push({ n, f }),
			close() {},
		};
		await runCompare({
			db: p.db,
			logger,
			items: planCompare({
				platforms,
				definitions: [
					{
						id: "wikipedia-article",
						needsHeaded: false,
						inputs: [{ query: "ひみつの検索語" }],
					},
				],
				caseIds: [],
				repeat: 1,
				headed: false,
			}),
			definitions: p.definitions,
			cases: new Map(),
			createSession: p.createSession,
		});
		const logged = JSON.stringify(events);
		expect(logged).toContain("definition.started");
		expect(logged).not.toContain("ひみつの検索語");
		expect(logged).not.toContain("アルゴリズム");
	});
});
