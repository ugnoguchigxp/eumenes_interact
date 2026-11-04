import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { FIXTURES_DIR, loadCases } from "../../cases/load.ts";
import { operateSummary } from "../../cli/operate-command.ts";
import { summaryLines } from "../../cli/report.ts";
import {
	ARM1_SCRIPTS_DIR,
	arm1ScriptSchema,
	findItem,
	knownItems,
	loadArm1Script,
	nextArm1Output,
} from "../../scripted/arm1.ts";
import { runScripted } from "./harness.ts";

const dev = await loadCases({ includeHoldout: false });
const live = (
	await loadCases({ includeHoldout: false, includeLive: true })
).filter((c) => c.split === "live");
const holdout = (await loadCases({ includeHoldout: true })).filter(
	(c) => c.split === "holdout",
);

describe("the Arm 1 scripts of the dev cases", () => {
	test("every dev and live case has one and there is no other", async () => {
		const files = (await readdir(ARM1_SCRIPTS_DIR)).filter((f) =>
			f.endsWith(".json"),
		);
		expect(files.sort()).toEqual(
			[...dev, ...live].map((c) => `${c.id}.json`).sort(),
		);
		for (const def of dev)
			expect((await loadArm1Script(def.id)).caseId).toBe(def.id);
	});

	test("the holdout cases have none", async () => {
		for (const def of holdout)
			await expect(loadArm1Script(def.id)).rejects.toThrow("no_script");
	});

	test("a script names items by role and name, never by id or ref", () => {
		for (const def of dev) {
			const text = readFileSync(
				join(ARM1_SCRIPTS_DIR, `${def.id}.json`),
				"utf8",
			);
			arm1ScriptSchema.parse(JSON.parse(text));
			expect(text).not.toMatch(/p\d+\.i\d+/);
			expect(text).not.toMatch(/\[ref=|"ref"|"item":/);
		}
	});

	test("a finish text carries the facts the case asks for", async () => {
		for (const def of dev) {
			if (def.expect.kind !== "reach" || !def.expect.answerIncludes) continue;
			const script = await loadArm1Script(def.id);
			const last = script.steps.at(-1);
			if (!last || !("done" in last)) throw new Error(`${def.id} must finish`);
			for (const fact of def.expect.answerIncludes)
				expect(last.done).toContain(fact);
		}
	});

	test("every name a script looks for appears in its fixture's pages", async () => {
		for (const def of dev) {
			const dir = join(
				FIXTURES_DIR,
				def.start.split("?")[0]!.split("/").slice(0, -1).join("/"),
			);
			const site = join(dir, "..");
			const files = [
				...readdirSync(dir)
					.filter((f) => f.endsWith(".html"))
					.map((f) => join(dir, f)),
				...readdirSync(site)
					.filter((f) => f.endsWith(".js"))
					.map((f) => join(site, f)),
			];
			const html = files.map((f) => readFileSync(f, "utf8")).join("\n");
			for (const step of (await loadArm1Script(def.id)).steps) {
				if (!("part" in step)) continue;
				const targets = [
					...(step.target ? [step.target] : []),
					...(step.fields ?? []).map((f) => f.target),
				];
				for (const t of targets) if (t.name) expect(html).toContain(t.name);
				for (const f of step.fields ?? [])
					if (f.target.role === "combobox") expect(html).toContain(f.value);
			}
		}
	});

	test("a part that needs a form's approval is the one that submits; a search button is opened, not submitted", async () => {
		for (const def of dev) {
			const steps = (await loadArm1Script(def.id)).steps;
			const submits = steps.filter(
				(s) => "part" in s && s.part === "form.submit",
			);
			if (def.expect.approval === "none") expect(submits).toHaveLength(0);
			if (def.expect.approval === "required")
				expect(submits.length).toBeGreaterThan(0);
		}
	});
});

describe("choosing an item from what the core showed", () => {
	const items = [
		{ item: "p1.i1", role: "link", name: "ホーム" },
		{ item: "p1.i2", role: "link", name: "一覧", region: "region A" },
		{ item: "p1.i3", role: "link", name: "一覧", region: "region B" },
	];
	test("by role, name and region; several are ambiguous unless nth names one", () => {
		expect(findItem(items, { role: "link", name: "ホーム" })).toMatchObject({
			kind: "found",
			item: { item: "p1.i1" },
		});
		expect(findItem(items, { role: "link", name: "一覧" })).toEqual({
			kind: "ambiguous",
		});
		expect(findItem(items, { name: "一覧", region: "B" })).toMatchObject({
			kind: "found",
			item: { item: "p1.i3" },
		});
		expect(findItem(items, { name: "一覧", nth: 0 })).toMatchObject({
			kind: "found",
			item: { item: "p1.i2" },
		});
		expect(findItem(items, { name: "なし" })).toEqual({ kind: "none" });
	});

	test("an item it cannot find becomes an ask, never a guess", () => {
		const out = nextArm1Output(
			{
				caseId: "x",
				steps: [{ part: "item.open", target: { role: "link", name: "ない" } }],
			},
			[
				{ role: "system", content: "s" },
				{
					role: "user",
					content: `REFERENCE=${JSON.stringify({ page: { page: "p1", items } })}`,
				},
				{ role: "user", content: "request" },
			],
		);
		expect(JSON.parse(out)).toMatchObject({ part: "ask" });
	});

	test("the known set follows the core: a result about another page starts it again", () => {
		const known = knownItems([
			{ role: "system", content: "s" },
			{
				role: "user",
				content: `REFERENCE=${JSON.stringify({ page: { page: "p1", items } })}`,
			},
			{ role: "user", content: "request" },
			{ role: "assistant", content: "{}" },
			{
				role: "user",
				content: `PART_RESULT=${JSON.stringify({
					resultId: "r1",
					page: {
						page: "p2",
						items: [{ item: "p2.i1", role: "link", name: "次" }],
					},
				})}`,
			},
		]);
		expect(known.map((i) => i.item)).toEqual(["p2.i1"]);
	});
});

/** The cases the fake browser has pages for; the rest need the real fixtures (a browser). */
const ON_THE_FAKE = [
	"dev-search-base",
	"dev-search-duplicate",
	"dev-tab-base",
	"dev-form-base",
	"dev-approval-deny",
	"dev-clarify-form",
	"dev-capture-results",
	"dev-capture-item",
	"dev-capture-full",
	"dev-form-multifield",
	"dev-form-multifield-ask",
	"dev-read-table",
];

describe("the fixed-response acceptance of Arm 1, on the fake browser", () => {
	for (const id of ON_THE_FAKE)
		test(`${id} is a scored success`, async () => {
			const { result } = await runScripted(id, { arm: "arm1" });
			expect(result.score.failures).toEqual([]);
			expect(result.score.success).toBe(true);
			expect(result.transcript.arm).toBe("arm1");
			// Every step the script took was accepted by the core's own parse.
			expect(
				result.transcript.events.filter(
					(e) => e.type === "step.parse" && !e.accepted,
				),
			).toEqual([]);
		});

	test("a screenshot case: the file is in the run's capture directory and the transcript says where", async () => {
		const { result } = await runScripted("dev-capture-full", { arm: "arm1" });
		const saved = result.transcript.events.flatMap((e) =>
			e.type === "capture.saved" ? [e] : [],
		);
		expect(saved).toHaveLength(1);
		expect(isAbsolute(result.transcript.captureDir!)).toBe(true);
		expect(result.captureDir).toBe(result.transcript.captureDir!);
		expect(existsSync(join(result.captureDir, saved[0]!.fileName))).toBe(true);
		expect(saved[0]!.fileName).not.toContain("/");
	});

	test("the parts the model called are in the transcript, in order", async () => {
		const { result } = await runScripted("dev-capture-results", {
			arm: "arm1",
		});
		expect(
			result.transcript.events.flatMap((e) =>
				e.type === "part.call" ? [e.part] : [],
			),
		).toEqual(["site.search", "page.capture"]);
	});

	test("run and operate print the parts called and the screenshots saved", async () => {
		const { result } = await runScripted("dev-capture-results", {
			arm: "arm1",
		});
		const lines = summaryLines(result);
		expect(lines).toContain("  parts: site.search > page.capture");
		expect(lines.find((l) => l.startsWith("  captures: 1 in "))).toContain(
			result.captureDir,
		);
		const saved = result.transcript.events.flatMap((e) =>
			e.type === "capture.saved" ? [e.fileName] : [],
		);
		expect(lines).toContain(`    ${saved[0]}`);
		const shown = operateSummary({
			runId: "r",
			status: "completed",
			startedAt: "x",
			modelCalls: 3,
			operations: 1,
			parts: ["site.search", "page.capture", "form.submit(needs_approval)"],
			captureDir: "/abs/dir",
			captures: ["a-1-viewport.png"],
			tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
			costUsdEstimate: null,
		});
		expect(shown).toContain(
			"parts\tsite.search > page.capture > form.submit(needs_approval)",
		);
		expect(shown).toContain("captures\t1\t/abs/dir");
		expect(shown).toContain("  a-1-viewport.png");
	});
});
