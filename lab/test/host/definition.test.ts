import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	definitionDigest,
	originAllowed,
	parseDefinition,
	type WorkDefinition,
} from "eumenes-interact";
import {
	findSiteObjects,
	getRun,
	listEvidence,
	listOperations,
} from "eumenes-interact/sqlite";
import { FixtureApprover, StopApprover } from "../../host/approval.ts";
import { RunControl } from "../../host/control.ts";
import { runDefinition } from "../../host/definition-run.ts";
import { loadDefinitions, readDefinition } from "../../host/definitions.ts";
import {
	createPinoLogger,
	type LabEventName,
	type LabLogger,
} from "../../host/log.ts";
import { createObservationSink } from "../../host/observations.ts";
import { LAB_OWNER } from "../../host/run.ts";
import {
	importSeed,
	loadSeeds,
	readSeed,
	type Seed,
} from "../../knowledge/seed.ts";
import { FakeBrowser } from "./fake-adapter.ts";
import { freshDb } from "./harness.ts";

const NOW = "2026-11-03T00:00:00.000Z";
const DEFINITIONS = join(import.meta.dir, "../../definitions");
const KNOWLEDGE = join(import.meta.dir, "../../knowledge");

const wikipedia = await readDefinition(
	join(DEFINITIONS, "wikipedia-article.json"),
);
const wikiSeed = await readSeed(join(KNOWLEDGE, "wikipedia.json"));
/** The extract step names a content root, or reads generically: the sample's data decides, not the runner. */
const readRoot = wikipedia.steps.find(
	(s) => s.id === "read" && "targetObject" in s,
);

/** A logger that keeps everything it is given. */
function capturing(): LabLogger & { events: unknown[] } {
	const events: unknown[] = [];
	return {
		events,
		event: (name, fields) => void events.push({ name, ...fields }),
		lab: (name: LabEventName, fields) => void events.push({ name, ...fields }),
		close() {},
	};
}

function setup(seed: Seed = wikiSeed) {
	const db = freshDb();
	importSeed(db, LAB_OWNER, seed, NOW);
	return { db, adapter: new FakeBrowser(), logger: capturing() };
}

const run = (
	s: ReturnType<typeof setup>,
	query: string,
	extra: Partial<Parameters<typeof runDefinition>[0]> = {},
) =>
	runDefinition({
		db: s.db,
		definition: wikipedia,
		inputs: { query },
		adapter: s.adapter,
		logger: s.logger,
		...extra,
	});

const statuses = (r: Awaited<ReturnType<typeof run>>) =>
	Object.fromEntries(r.steps.map((s) => [s.id, s.status]));

describe("running the Wikipedia sample on a fake browser", () => {
	test("search, results, first article, extract: the JSON result", async () => {
		const s = setup();
		const r = await run(s, "人工知能");
		expect(r.ok).toBe(true);
		expect(r.status).toBe("completed");
		expect(r.code).toBeNull();
		expect(r.definition).toEqual({
			id: "wikipedia-article",
			revision: wikipedia.revision,
			digest: definitionDigest(wikipedia),
		});
		expect(r.inputs).toEqual({ query: "人工知能" });
		expect(r.runId).toMatch(/^[0-9a-f-]{36}$/);
		expect(r.finalUrl).toBe(
			"https://ja.wikipedia.org/wiki/%E6%A9%9F%E6%A2%B0%E5%AD%A6%E7%BF%92",
		);
		expect(r.steps.map((x) => [x.id, x.action, x.status])).toEqual([
			["open", "browser.navigate", "confirmed"],
			["query", "page.fill", "confirmed"],
			["wait_results", "page.wait", "confirmed"],
			["look_results", "page.observe", "confirmed"],
			["pick", "page.click", "confirmed"],
			["wait_page", "page.wait", "confirmed"],
			["look_page", "page.observe", "confirmed"],
			["read", "page.extract", "confirmed"],
		]);
		expect(r.extracts).toEqual({
			read: {
				url: r.finalUrl,
				title: "機械学習 - Wikipedia",
				text: "機械学習は、データから学習するアルゴリズムの研究分野である。",
				charCount: 30,
				truncated: false,
				root: readRoot ? "target" : "main",
			},
		});
		// The keyword was typed by reference; the first article link is the named /wiki/ one, not help,
		// special, the red link or the unnamed thumbnail.
		expect(s.adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
			"page.fill",
			"page.wait",
			"page.click",
			"page.wait",
		]);
		expect(s.adapter.dispatched[1]).toMatchObject({
			text: "人工知能",
			submit: true,
			targetRef: "e2",
		});
		expect(s.adapter.dispatched[3]).toMatchObject({ targetRef: "e8" });
		expect(s.adapter.extracted).toEqual([
			{ targetRef: readRoot ? "e3" : null, maxChars: 20000 },
		]);
		expect(s.adapter.closeCount).toBe(1);
	});

	test("an exact title jumps to the article: the optional click is skipped, only because its object is not defined there", async () => {
		const s = setup();
		const r = await run(s, "機械学習");
		expect(r.ok).toBe(true);
		expect(statuses(r).pick).toBe("skipped");
		expect(r.steps.find((x) => x.id === "pick")).toMatchObject({
			id: "pick",
			action: "page.click",
			status: "skipped",
			skipped: true,
		});
		expect(s.adapter.dispatched.map((c) => c.action)).not.toContain(
			"page.click",
		);
		expect(r.extracts.read?.text).toContain("機械学習");
	});

	test("a target that is defined for the page but not on it stops the run, optional or not", async () => {
		const s = setup();
		const empty = new FakeBrowser();
		// The results page loses every result link: the object is defined for it, but nothing matches.
		empty.onDispatch = (c, b) => {
			if (c.action === "page.fill") {
				b.goto("https://ja.wikipedia.org/w/index.php?search=x");
				return {
					status: "confirmed",
					retryable: false,
					url: b.url,
					title: "検索結果",
				};
			}
			return undefined;
		};
		const broken = new FakeBrowser();
		broken.onDispatch = empty.onDispatch;
		const original = broken.observe.bind(broken);
		broken.observe = async () => {
			const raw = await original();
			return {
				...raw,
				body: raw.body.replaceAll(/\n\s+- link[^\n]*\n[^\n]*\/url[^\n]*/g, ""),
			};
		};
		const r = await run({ ...s, adapter: broken }, "x");
		expect(r.ok).toBe(false);
		expect(r.status).toBe("failed");
		expect(r.code).toBe("target_not_found");
		expect(statuses(r).pick).toBe("failed");
		expect(statuses(r).read).toBe("not_run");
		expect(r.extracts).toEqual({});
		expect(broken.closeCount).toBe(1);
		expect(getRun(s.db, LAB_OWNER, r.runId!)?.status).toBe("failed");
	});

	test("a page without knowledge stops a step that needs it", async () => {
		const s = setup();
		const without = {
			...wikipedia,
			steps: wikipedia.steps.filter((x) => x.id !== "open"),
		};
		void without;
		const bare = new FakeBrowser();
		const db = freshDb(); // no seeds imported
		const r = await runDefinition({
			db,
			definition: wikipedia,
			inputs: { query: "x" },
			adapter: bare,
			logger: s.logger,
		});
		expect(r.status).toBe("failed");
		expect(r.code).toBe("object_undefined");
		expect(statuses(r).query).toBe("failed");
		expect(bare.dispatched.map((c) => c.action)).toEqual(["browser.navigate"]);
	});

	test("evidence is recorded for what a stored candidate found, and nothing becomes verified", async () => {
		const s = setup();
		const r = await run(s, "人工知能");
		const object = (name: string) =>
			findSiteObjects(s.db, LAB_OWNER, {
				origin: "https://ja.wikipedia.org",
				logicalName: name,
			})[0]!;
		const ops = listOperations(s.db, LAB_OWNER, r.runId!);
		const query = object("search.query");
		const pick = object("search.first_result");
		const forQuery = listEvidence(s.db, LAB_OWNER, query.id);
		const forPick = listEvidence(s.db, LAB_OWNER, pick.id);
		expect(forQuery).toHaveLength(1);
		expect(forQuery[0]).toMatchObject({
			outcome: "match",
			runId: r.runId,
			operationId: ops.find((o) => o.action === "page.fill")!.operationId,
			candidateId: query.candidates[0]!.id,
		});
		expect(forPick[0]).toMatchObject({
			operationId: ops.find((o) => o.action === "page.click")!.operationId,
		});
		for (const o of [query, pick, object("article.body")])
			expect(o.candidates.every((c) => c.status === "candidate")).toBe(true);
		// A skipped step or a refused one leaves none.
		const skipped = setup();
		await run(skipped, "機械学習");
		const skipObject = findSiteObjects(skipped.db, LAB_OWNER, {
			origin: "https://ja.wikipedia.org",
			logicalName: "search.first_result",
		})[0]!;
		expect(listEvidence(skipped.db, LAB_OWNER, skipObject.id)).toEqual([]);
	});

	test("the run is frozen to the definition's revision and digest, and every operation is in the ledger", async () => {
		const s = setup();
		const r = await run(s, "人工知能");
		const stored = getRun(s.db, LAB_OWNER, r.runId!)!;
		expect(stored.workflow).toEqual({
			id: "wikipedia-article",
			revision: wikipedia.revision,
			digest: definitionDigest(wikipedia),
		});
		expect(stored.status).toBe("completed");
		expect(stored.skill.ref).toBe("skill:interact.execute@1");
		expect(stored.coreState).toBeNull();
		const ops = listOperations(s.db, LAB_OWNER, r.runId!);
		expect(ops.map((o) => [o.action, o.status])).toEqual([
			["browser.navigate", "confirmed"],
			["page.fill", "confirmed"],
			["page.wait", "confirmed"],
			["page.click", "confirmed"],
			["page.wait", "confirmed"],
		]);
		expect(ops.every((o) => o.dispatchedAt !== null)).toBe(true);
	});
});

describe("a results page that redirects after the submit, and a click that goes nowhere", () => {
	const settledResults = (b: FakeBrowser) => {
		b.goto(
			"https://ja.wikipedia.org/w/index.php?search=x&title=%E7%89%B9%E5%88%A5%3A%E6%A4%9C%E7%B4%A2",
		);
		b.settleTo =
			"https://ja.wikipedia.org/w/index.php?search=x&title=特別:検索&ns0=1";
		return {
			status: "confirmed" as const,
			retryable: false,
			url: b.url,
			title: "検索結果",
		};
	};

	test("the definition run follows the page to the URL it settled on and goes on", async () => {
		const s = setup();
		s.adapter.onDispatch = (c, b) =>
			c.action === "page.fill" ? settledResults(b) : undefined;
		const r = await run(s, "x");
		expect(r.status).toBe("completed");
		expect(r.extracts.read?.text).toContain("機械学習");
		expect(statuses(r).wait_results).toBe("confirmed");
		expect(s.logger.events).toContainEqual(
			expect.objectContaining({
				name: "tab.navigation_followed",
				code: "tab_url_settled",
			}),
		);
	});

	test("urlChanged says whether a click or a submitted fill moved the page; other steps have none", async () => {
		const s = setup();
		const r = await run(s, "人工知能");
		const flag = (id: string) => r.steps.find((x) => x.id === id)?.urlChanged;
		expect(flag("query")).toBe(true);
		expect(flag("pick")).toBe(true);
		for (const id of [
			"open",
			"wait_results",
			"look_results",
			"wait_page",
			"look_page",
			"read",
		])
			expect(r.steps.find((x) => x.id === id)).not.toHaveProperty("urlChanged");
		// A confirmed click that left the URL alone (a page script handled it) shows as false.
		const stuck = setup();
		stuck.adapter.onDispatch = (c, b) =>
			c.action === "page.click"
				? {
						status: "confirmed",
						retryable: false,
						url: b.url,
						title: "検索結果",
					}
				: undefined;
		const q = await run(stuck, "人工知能");
		// The click was confirmed but the page is still the results page. A sample that reads the body through
		// an object (not defined there) stops; one that reads generically reads what is on the page. Either
		// way the caller can see from the flag that the click went nowhere.
		if (readRoot) {
			expect(q.status).toBe("failed");
			expect(q.code).toBe("object_undefined");
		} else expect(q.status).toBe("completed");
		expect(q.steps.find((x) => x.id === "pick")).toMatchObject({
			status: "confirmed",
			urlChanged: false,
		});
		expect(q.steps.find((x) => x.id === "query")?.urlChanged).toBe(true);
		// A skipped step has none.
		expect(
			(await run(setup(), "機械学習")).steps.find((x) => x.id === "pick"),
		).toMatchObject({
			id: "pick",
			action: "page.click",
			status: "skipped",
			skipped: true,
		});
	});
});

describe("metrics for the comparison of platforms", () => {
	test("every step has a duration, observe steps their snapshot size and refs, extract steps their length", async () => {
		const s = setup();
		const r = await run(s, "人工知能");
		for (const step of r.steps)
			expect(step.durationMs).toBeGreaterThanOrEqual(0);
		const look = r.steps.find((x) => x.id === "look_results")!;
		const results = new TextEncoder().encode(
			[
				"- banner [ref=e1]:",
				'  - searchbox "Wikipedia内を検索" [ref=e2]',
				"- main [ref=e3]:",
				'  - link "ヘルプ" [ref=e4]:',
				"    - /url: /wiki/Help:%E6%A4%9C%E7%B4%A2",
				'  - link "特別ページ" [ref=e5]:',
				"    - /url: /wiki/%E7%89%B9%E5%88%A5:%E6%A4%9C%E7%B4%A2",
				'  - link "赤リンク" [ref=e6]:',
				"    - /url: /w/index.php?title=X&action=edit&redlink=1",
				"  - link [ref=e7]:",
				"    - /url: /wiki/%E6%A9%9F%E6%A2%B0%E5%AD%A6%E7%BF%92",
				'  - link "機械学習" [ref=e8]:',
				"    - /url: /wiki/%E6%A9%9F%E6%A2%B0%E5%AD%A6%E7%BF%92",
				'  - link "人工知能" [ref=e9]:',
				"    - /url: /wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD",
			].join("\n"),
		).length;
		expect(look.bodyBytes).toBe(results);
		expect(look.refCount).toBe(9);
		const page = r.steps.find((x) => x.id === "look_page")!;
		expect(page.bodyBytes).toBeGreaterThan(0);
		expect(page.refCount).toBe(5);
		expect(r.steps.find((x) => x.id === "read")).toMatchObject({
			charCount: 30,
		});
		for (const id of [
			"open",
			"query",
			"wait_results",
			"pick",
			"wait_page",
			"read",
		])
			expect(r.steps.find((x) => x.id === id)).not.toHaveProperty("bodyBytes");
		for (const id of [
			"open",
			"query",
			"look_results",
			"pick",
			"wait_page",
			"look_page",
		])
			expect(r.steps.find((x) => x.id === id)).not.toHaveProperty("charCount");
	});

	test("the stored summary keeps the numbers and none of the page's text", async () => {
		const s = setup();
		await run(s, "機械学習");
		const stored = (
			s.db.query("SELECT summary_json FROM lab_definition_runs").get() as {
				summary_json: string;
			}
		).summary_json;
		expect(stored).toContain("bodyBytes");
		expect(stored).not.toContain("アルゴリズム");
	});

	test("the platform and tool of a refused run are known too", async () => {
		const s = setup();
		const r = await runDefinition({
			db: s.db,
			definition: wikipedia,
			inputs: {},
			adapter: s.adapter,
			logger: s.logger,
		});
		expect(r).toMatchObject({
			status: "rejected",
			platform: "playwright-mcp",
			tool: null,
		});
	});
});

describe("inputs", () => {
	test("a bad input is refused before any run exists", async () => {
		const s = setup();
		for (const [inputs, code] of [
			[{}, "missing_input"],
			[{ query: "" }, undefined],
			[{ query: "x".repeat(101) }, undefined],
			[{ query: "x", other: "y" }, "unknown_input"],
		] as const) {
			const r = await runDefinition({
				db: s.db,
				definition: wikipedia,
				inputs: inputs as unknown as Record<string, string>,
				adapter: s.adapter,
				logger: s.logger,
			});
			expect(r.ok).toBe(false);
			expect(r.status).toBe("rejected");
			expect(r.runId).toBeNull();
			expect(r.issues?.length).toBeGreaterThan(0);
			if (code) expect(r.issues?.map((i) => i.code)).toContain(code);
		}
		expect(s.adapter.calls).toEqual([]);
		expect(s.db.query("SELECT COUNT(*) AS n FROM interact_runs").get()).toEqual(
			{ n: 0 },
		);
		expect(
			s.db.query("SELECT COUNT(*) AS n FROM interact_workflow_revisions").get(),
		).toEqual({ n: 0 });
	});

	test("the same id and revision with other content is a conflict, not a silent overwrite", async () => {
		const s = setup();
		expect((await run(s, "機械学習")).ok).toBe(true);
		const changed: WorkDefinition = { ...wikipedia, title: "別のタイトル" };
		const r = await runDefinition({
			db: s.db,
			definition: changed,
			inputs: { query: "機械学習" },
			adapter: new FakeBrowser(),
			logger: s.logger,
		});
		expect(r.status).toBe("rejected");
		expect(r.code).toBe("definition_revision_conflict");
		// The same definition again is fine: it is the stored revision.
		expect((await run(s, "機械学習")).ok).toBe(true);
	});

	test("the keyword is in no log and in no database table: the database keeps a digest", async () => {
		const secret = "秘密のキーワード人工知能";
		const s = setup();
		const dir = mkdtempSync(join(tmpdir(), "interact-def-log-test-"));
		try {
			const pino = createPinoLogger(dir, "2026-11-03");
			const r = await run(s, secret, { logger: pino });
			pino.close();
			expect(r.status).toBe("completed");
			const file = readFileSync(join(dir, "lab-2026-11-03.jsonl"), "utf8");
			expect(file).toContain("definition.started");
			expect(file).not.toContain(secret);
			expect(JSON.stringify(s.logger.events)).not.toContain(secret);
			const tables = (
				s.db
					.query("SELECT name FROM sqlite_master WHERE type = 'table'")
					.all() as { name: string }[]
			).map((t) => t.name);
			for (const table of tables)
				expect(
					JSON.stringify(s.db.query(`SELECT * FROM ${table}`).all()),
				).not.toContain(secret);
			const row = s.db
				.query("SELECT inputs_sha256 FROM lab_definition_runs")
				.get() as { inputs_sha256: string };
			expect(row.inputs_sha256).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a run that stays on the results page does not store the keyword through its final URL either", async () => {
		const secret = "ひみつの語";
		const s = setup();
		const stuck = new FakeBrowser();
		const original = stuck.observe.bind(stuck);
		stuck.observe = async () => {
			const raw = await original();
			return {
				...raw,
				body: raw.body.replaceAll(/\n\s+- link[^\n]*\n[^\n]*\/url[^\n]*/g, ""),
			};
		};
		const r = await run({ ...s, adapter: stuck }, secret);
		expect(r.status).toBe("failed");
		expect(r.finalUrl).toContain(encodeURIComponent(secret));
		const summary = s.db
			.query("SELECT summary_json FROM lab_definition_runs")
			.get() as { summary_json: string };
		expect(summary.summary_json).not.toContain(encodeURIComponent(secret));
		expect(JSON.parse(summary.summary_json).finalUrl).toBe(
			"https://ja.wikipedia.org/w/index.php",
		);
	});
});

/** A definition of one click on a plain button, for approval behaviour. */
const BUTTON: WorkDefinition = {
	formatVersion: 1,
	id: "wikipedia-menu",
	revision: 1,
	title: "メニューを押す",
	skillRef: "skill:interact.execute@1",
	catalogRef: "catalog:interact.actions@1",
	allowedOrigins: ["https://ja.wikipedia.org"],
	inputs: {
		type: "object",
		properties: {},
		required: [],
		additionalProperties: false,
	},
	steps: [
		{
			id: "open",
			action: "browser.navigate",
			args: { url: "https://ja.wikipedia.org/" },
			expectation: "トップが開いている",
		},
		{
			id: "menu",
			action: "page.click",
			targetObject: "menu.button",
			expectation: "メニューが押されている",
		},
	],
};
const withMenu = (): Seed => {
	const seed: Seed = structuredClone(wikiSeed);
	seed.objects.push({
		profile: "any",
		logicalName: "menu.button",
		description: "メニューのボタン",
		candidates: [
			{
				kind: "role",
				fields: { role: "button", name: "メニュー" },
				source: { adapter: "playwright-mcp", via: "snapshot" },
			},
		],
	});
	return seed;
};

describe("approvals", () => {
	test("by default a click that needs approval stops the run as needs_input and says what it would do", async () => {
		const s = setup(withMenu());
		const r = await runDefinition({
			db: s.db,
			definition: BUTTON,
			inputs: {},
			adapter: s.adapter,
			logger: s.logger,
		});
		expect(r.ok).toBe(false);
		expect(r.status).toBe("needs_input");
		expect(r.code).toBe("approval_required");
		expect(statuses(r)).toEqual({
			open: "confirmed",
			menu: "needs_input",
		});
		expect(r.approval).toMatchObject({ action: "click", element: "メニュー" });
		expect(r.approval?.page).toBe("https://ja.wikipedia.org/");
		expect(s.adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
		]);
		const ops = listOperations(s.db, LAB_OWNER, r.runId!);
		expect(ops.at(-1)).toMatchObject({
			status: "failed",
			resultCode: "approval_denied",
			dispatchedAt: null,
		});
		expect(getRun(s.db, LAB_OWNER, r.runId!)?.status).toBe("needs_input");
	});

	test("the approver is the caller's: a grant sends it, and the stop approver never does", async () => {
		const granted = setup(withMenu());
		const asked: string[] = [];
		const r = await runDefinition({
			db: granted.db,
			definition: BUTTON,
			inputs: {},
			adapter: granted.adapter,
			logger: granted.logger,
			approver: {
				decide: (prompt) => {
					asked.push(`${prompt.action}`);
					return new FixtureApprover({ decision: "grant" }).decide();
				},
			},
		});
		expect(r.ok).toBe(true);
		expect(asked).toEqual(["click"]);
		expect(granted.adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
			"page.click",
		]);
		const stop = new StopApprover();
		expect(
			await stop.decide({
				approvalId: "a",
				operationId: "o",
				tabRef: "t",
				page: "p",
				action: "click",
				element: "e",
				summary: "s",
			}),
		).toBe("deny");
		expect(stop.prompt?.action).toBe("click");
	});

	test("a link and a GET search need none: the sample runs unattended", async () => {
		const s = setup();
		const r = await run(s, "人工知能");
		expect(r.approval).toBeUndefined();
		expect(r.ok).toBe(true);
	});
});

describe("cancel and the policy", () => {
	test("a cancel during a send stops the run and the late result is not used", async () => {
		const s = setup();
		const control = new RunControl();
		s.adapter.onDispatch = (c) => {
			if (c.action === "page.fill") control.cancel("cancel");
			return undefined;
		};
		const r = await run(s, "人工知能", { control });
		expect(r.status).toBe("cancelled");
		expect(r.ok).toBe(false);
		expect(s.adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
			"page.fill",
		]);
		expect(getRun(s.db, LAB_OWNER, r.runId!)?.status).toBe("cancelled");
		expect(s.adapter.closeCount).toBe(1);
		expect(r.extracts).toEqual({});
	});

	test("a page outside the definition's origins is never adopted", async () => {
		const s = setup();
		s.adapter.onDispatch = (c) =>
			c.action === "page.fill"
				? {
						status: "confirmed",
						retryable: false,
						url: "https://evil.example/",
					}
				: undefined;
		const r = await run(s, "人工知能");
		expect(r.status).toBe("failed");
		expect(r.code).toBe("navigation_out_of_scope");
		expect(r.extracts).toEqual({});
	});

	test("an unexpected error still closes the adapter and finishes the run row", async () => {
		const s = setup();
		s.adapter.extractError = new Error("boom");
		await expect(run(s, "機械学習")).rejects.toThrow("boom");
		expect(s.adapter.closeCount).toBe(1);
		const [row] = s.db
			.query("SELECT status FROM lab_definition_runs")
			.all() as { status: string }[];
		expect(row?.status).toBe("failed");
	});
});

describe("keeping what was read", () => {
	test("without a sink the text is returned and kept nowhere; with one, observations and extracts go to <runId>/", async () => {
		const plain = setup();
		const r = await run(plain, "機械学習");
		expect(r.extracts.read?.text).toContain("機械学習");
		for (const table of [
			"interact_operations",
			"lab_definition_runs",
			"interact_runs",
		])
			expect(
				JSON.stringify(plain.db.query(`SELECT * FROM ${table}`).all()),
			).not.toContain("アルゴリズム");
		const dir = mkdtempSync(join(tmpdir(), "interact-def-obs-test-"));
		try {
			const kept = setup();
			const k = await run(kept, "機械学習", {
				observationSink: createObservationSink(dir),
			});
			const files = readdirSync(join(dir, k.runId!));
			expect(files.length).toBeGreaterThanOrEqual(3);
			const all = files
				.map((f) => readFileSync(join(dir, k.runId!, f), "utf8"))
				.join("\n");
			expect(all).toContain("[extract read]");
			expect(all).toContain("アルゴリズム");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the samples", () => {
	const pairs = [
		["wikipedia-article", "wikipedia"],
		["gizmodo-article", "gizmodo"],
		["slashdot-story", "slashdot"],
		["biggo-product", "biggo"],
	] as const;

	test("all four parse with the package's parseDefinition and take a keyword", async () => {
		const loaded = await loadDefinitions();
		expect(loaded.map((l) => l.file)).toEqual(
			pairs.map(([d]) => `${d}.json`).sort(),
		);
		for (const { file, definition } of loaded) {
			expect(`${definition.id}.json`).toBe(file);
			expect(
				parseDefinition(
					JSON.parse(readFileSync(join(DEFINITIONS, file), "utf8")),
				).ok,
			).toBe(true);
			expect(definition.inputs).toEqual({
				type: "object",
				properties: {
					query: {
						type: "string",
						minLength: 1,
						maxLength: 100,
						description: "検索するキーワード",
					},
				},
				required: ["query"],
				additionalProperties: false,
			});
			expect(definition.skillRef).toBe("skill:interact.execute@1");
			expect(definition.catalogRef).toBe("catalog:interact.actions@1");
			expect(definition.steps.map((s) => s.action).slice(0, 2)).toEqual([
				"browser.navigate",
				"page.fill",
			]);
			expect(definition.steps.at(-1)?.action).toBe("page.extract");
		}
	});

	test("every targetObject is defined in the matching seed, and the seed's origins are the definition's", async () => {
		const seeds = new Map((await loadSeeds()).map((s) => [s.file, s.seed]));
		for (const [id, site] of pairs) {
			const definition = await readDefinition(join(DEFINITIONS, `${id}.json`));
			const seed = seeds.get(`${site}.json`)!;
			expect(seed).toBeDefined();
			for (const origin of seed.origins)
				expect(originAllowed(definition.allowedOrigins, origin)).toBe(true);
			const defined = new Set(seed.objects.map((o) => o.logicalName));
			for (const step of definition.steps)
				if ("targetObject" in step && step.targetObject !== undefined)
					expect(defined.has(step.targetObject)).toBe(true);
			// The start page is on an origin the seed knows, so the first target resolves.
			const start = definition.steps[0];
			if (start?.action !== "browser.navigate")
				throw new Error("first step navigates");
			expect(seed.origins).toContain(new URL(String(start.args.url)).origin);
		}
	});

	test("the sites are as probed: wildcard for Slashdot, optional pick for Wikipedia only, generic extract elsewhere", async () => {
		const get = (id: string) => readDefinition(join(DEFINITIONS, `${id}.json`));
		expect((await get("slashdot-story")).allowedOrigins).toEqual([
			"https://*.slashdot.org",
		]);
		const optionalPick = async (id: string) =>
			(await get(id)).steps.find((s) => s.id === "pick")?.optional === true;
		expect(await optionalPick("wikipedia-article")).toBe(true);
		for (const id of ["gizmodo-article", "slashdot-story", "biggo-product"])
			expect(await optionalPick(id)).toBe(false);
		const read = async (id: string) =>
			(await get(id)).steps.find((s) => s.id === "read");
		// Wikipedia reads the article generically or through an object, whichever its revision says.
		expect(await read("wikipedia-article")).toMatchObject({
			args: { maxChars: 20000 },
		});
		for (const id of ["gizmodo-article", "biggo-product"])
			expect(await read(id)).not.toHaveProperty("targetObject");
	});

	test("the first-result candidates of the sites match the facts of the probes", async () => {
		const seeds = new Map((await loadSeeds()).map((s) => [s.file, s.seed]));
		const first = (site: string) =>
			seeds
				.get(`${site}.json`)!
				.objects.find((o) => o.logicalName === "search.first_result")!;
		expect(first("gizmodo")).toMatchObject({ profile: "search_results" });
		expect(first("slashdot")).toMatchObject({ profile: "search_results" });
		expect(first("biggo")).toMatchObject({ profile: "any" });
		expect(seeds.get("slashdot.json")!.origins).toEqual([
			"https://slashdot.org",
		]);
		expect(first("biggo").candidates[0]!.fields).toMatchObject({
			urlIncludes: "/gp/",
			urlExcludes: "#price|/compare",
			nth: 0,
		});
		expect(
			seeds.get("biggo.json")!.objects[0]!.candidates[0]!.fields.name,
		).toBe("検索…");
	});
});
