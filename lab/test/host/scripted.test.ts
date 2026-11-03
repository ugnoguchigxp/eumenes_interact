import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	ARM0_TOOL_IDS,
	parseStep,
	startRun,
	prepareStep,
	type StartRunInput,
} from "eumenes-interact";
import { FIXTURES_DIR, loadCases } from "../../cases/load.ts";
import {
	createScriptedInference,
	nextOutput,
} from "../../scripted/inference.ts";
import { parseAria, resolveTarget } from "../../scripted/resolve.ts";
import {
	SCRIPTS_DIR,
	loadScript,
	scriptSchema,
} from "../../scripted/script.ts";

const dev = await loadCases({ includeHoldout: false });
const live = (
	await loadCases({ includeHoldout: false, includeLive: true })
).filter((c) => c.split === "live");
const holdout = (await loadCases({ includeHoldout: true })).filter(
	(c) => c.split === "holdout",
);

describe("scripts of the dev cases", () => {
	test("every dev and live case has a script and there is no other", async () => {
		const files = (await readdir(SCRIPTS_DIR)).filter((f) =>
			f.endsWith(".json"),
		);
		expect(files.sort()).toEqual(
			[...dev, ...live].map((c) => `${c.id}.json`).sort(),
		);
		for (const def of [...dev, ...live])
			expect((await loadScript(def.id)).caseId).toBe(def.id);
	});

	test("the holdout cases have none", async () => {
		for (const def of holdout)
			await expect(loadScript(def.id)).rejects.toThrow("no_script");
	});

	test("a script only names Arm 0 tools, and never a ref", async () => {
		for (const def of [...dev, ...live]) {
			const text = await readFile(join(SCRIPTS_DIR, `${def.id}.json`), "utf8");
			const script = scriptSchema.parse(JSON.parse(text));
			for (const step of script.steps)
				if ("tool" in step) {
					expect(ARM0_TOOL_IDS as readonly string[]).toContain(step.tool);
					expect(Object.keys(step.args ?? {})).not.toContain("ref");
					expect(Object.keys(step.args ?? {})).not.toContain("observationRef");
				}
			expect(text).not.toMatch(/\[ref=|"ref"/);
		}
	});

	test("a finish text carries the facts the case asks for", async () => {
		for (const def of dev) {
			if (def.expect.kind !== "reach" || !def.expect.answerIncludes) continue;
			const script = await loadScript(def.id);
			const last = script.steps.at(-1);
			if (!last || !("finish" in last))
				throw new Error(`${def.id} must finish`);
			for (const fact of def.expect.answerIncludes)
				expect(last.finish).toContain(fact);
		}
	});

	test("an unknown tool id or field is rejected by the schema", () => {
		const step = { tool: "browser.page.script" };
		expect(scriptSchema.safeParse({ caseId: "x", steps: [step] }).success).toBe(
			false,
		);
		expect(
			scriptSchema.safeParse({
				caseId: "x",
				steps: [{ tool: "browser.page.click", extra: 1 }],
			}).success,
		).toBe(false);
	});

	test("every name a script looks for appears in its fixture's pages", async () => {
		for (const def of dev) {
			const dir = join(
				FIXTURES_DIR,
				def.start.split("?")[0]!.split("/").slice(0, -1).join("/"),
			);
			// The site's scripts hold the data the pages show (the book titles).
			const site = join(dir, "..");
			const files = [
				...(await readdir(dir))
					.filter((f) => f.endsWith(".html"))
					.map((f) => join(dir, f)),
				...(await readdir(site))
					.filter((f) => f.endsWith(".js"))
					.map((f) => join(site, f)),
			];
			const html = (
				await Promise.all(files.map((f) => readFile(f, "utf8")))
			).join("\n");
			const script = await loadScript(def.id);
			for (const step of script.steps) {
				if (!("tool" in step)) continue;
				if (step.target) {
					if (step.target.name) expect(html).toContain(step.target.name);
					for (const a of step.target.within ?? [])
						if (a.name) expect(html).toContain(a.name);
				}
				const label = (step.args as { values?: string[] } | undefined)
					?.values?.[0];
				if (label) expect(html).toContain(label);
			}
		}
	});
});

const BODY = [
	"- banner [ref=e1]:",
	"  - search [ref=e2]:",
	'    - searchbox "書名・著者" [ref=e3]',
	'    - button "検索" [ref=e4] [cursor=pointer]',
	'- region "蔵書検索" [ref=e5]:',
	'  - searchbox "書名・著者" [ref=e6]',
	'  - button "検索" [ref=e7]',
	'  - link "新着" [ref=e8]:',
	"    - /url: /new",
	"  - text: 新着の本",
].join("\n");

describe("resolving a target by role and name", () => {
	test("the elements and their ancestors are read from the snapshot", () => {
		const nodes = parseAria(BODY);
		expect(nodes.map((n) => n.role)).toEqual([
			"banner",
			"search",
			"searchbox",
			"button",
			"region",
			"searchbox",
			"button",
			"link",
		]);
		expect(nodes[5]?.parents.map((p) => p.name)).toEqual(["蔵書検索"]);
	});

	test("one match is found, none and two are told apart", () => {
		expect(resolveTarget(BODY, { role: "link", name: "新着" })).toEqual({
			kind: "found",
			ref: "e8",
			role: "link",
			name: "新着",
		});
		expect(resolveTarget(BODY, { role: "link", name: "ない" })).toEqual({
			kind: "none",
		});
		expect(resolveTarget(BODY, { role: "button", name: "検索" })).toEqual({
			kind: "ambiguous",
		});
		expect(
			resolveTarget(BODY, {
				role: "button",
				name: "検索",
				within: [{ role: "region", name: "蔵書検索" }],
			}),
		).toMatchObject({ kind: "found", ref: "e7" });
	});

	test("an element without a ref is not a target", () => {
		expect(
			resolveTarget('- button "x"', { role: "button", name: "x" }),
		).toEqual({ kind: "none" });
	});
});

/** The first messages the core would hand to inference for a page. */
function messagesFor(body: string) {
	const input: StartRunInput = {
		arm: "arm0",
		request: "「白波」を検索してください。",
		reference: {
			tabs: [
				{
					tabRef: "11111111-1111-4111-8111-111111111111",
					url: "http://127.0.0.1:1/",
					title: "t",
					current: true,
				},
			],
			observation: {
				observationRef: "22222222-2222-4222-8222-222222222222",
				platform: "playwright-mcp",
				sessionId: "s",
				target: { kind: "tab", tabRef: "11111111-1111-4111-8111-111111111111" },
				generation: 0,
				capturedAt: "2026-11-03T00:00:00.000Z",
				url: "http://127.0.0.1:1/",
				title: "t",
				body,
				truncated: false,
				truncationReasons: [],
				refCount: 8,
				missing: [],
			},
		},
		policy: { maxModelCalls: 5, retries: { default: 1 } },
		nowMs: 0,
	};
	return startRun(input);
}

describe("the scripted inference goes through the same parseStep as a model", () => {
	const script = {
		caseId: "x",
		steps: [
			{
				tool: "browser.page.type" as const,
				target: {
					role: "searchbox",
					name: "書名・著者",
					within: [{ role: "region", name: "蔵書検索" }],
				},
				args: {
					value: "白波",
					quote: "白波",
					purpose: "検索語",
					submit: false,
				},
			},
			{
				tool: "browser.page.click" as const,
				target: { role: "button", name: "検索" },
				args: { effect: "navigate" },
			},
		],
	};

	test("a resolved step is a valid call to the host", async () => {
		const state = messagesFor(BODY);
		const out = await createScriptedInference(script).complete({
			messages: prepareStep(state).messages,
			maxOutputTokens: 100,
			signal: new AbortController().signal,
		});
		if (out.kind !== "text") throw new Error("text expected");
		expect(out.usage).toEqual({ inputTokens: null, outputTokens: null });
		const parsed = parseStep(state, out.text);
		expect(parsed.record.accepted).toBe(true);
		expect(parsed.step).toMatchObject({
			kind: "call",
			call: {
				kind: "operate",
				command: { action: "page.fill", targetRef: "e6", text: "白波" },
			},
		});
	});

	test("an ambiguous target is a clarify, not a guess", () => {
		const state = messagesFor(BODY);
		const advanced = {
			...script,
			steps: [script.steps[1]!],
		};
		const raw = nextOutput(advanced, prepareStep(state).messages);
		expect(JSON.parse(raw)).toMatchObject({ action: "clarify" });
		expect(parseStep(state, raw).step.kind).toBe("clarify");
	});

	test("two tabs that match a title are ambiguous, not the first one", () => {
		const base = messagesFor(BODY);
		const tab = (n: number) => ({
			tabRef: `3333333${n}-3333-4333-8333-333333333333`,
			title: `ご利用案内 ${n}`,
			place: "http://127.0.0.1:1/",
			active: false,
		});
		const withTabs = (tabs: ReturnType<typeof tab>[]) => {
			const messages = prepareStep(base).messages.map((m) => ({ ...m }));
			messages.splice(3, 0, {
				role: "user",
				content: `TOOL_RESULT=${JSON.stringify({ ok: true, tabs })}`,
			});
			return messages;
		};
		const script = {
			caseId: "x",
			steps: [
				{
					tool: "browser.page.tab_select" as const,
					tab: { title: "ご利用案内" },
				},
			],
		};
		expect(
			JSON.parse(nextOutput(script, withTabs([tab(1), tab(2)]))),
		).toMatchObject({
			action: "clarify",
		});
		expect(JSON.parse(nextOutput(script, withTabs([tab(1)])))).toMatchObject({
			action: "invoke",
			arguments: { tabRef: tab(1).tabRef },
		});
	});

	test("a missing target and a used-up script are clarifies too", () => {
		const state = messagesFor("- main [ref=e1]");
		const raw = nextOutput(script, prepareStep(state).messages);
		expect(JSON.parse(raw).action).toBe("clarify");
		const done = nextOutput(
			{ caseId: "x", steps: [] as never },
			prepareStep(state).messages,
		);
		expect(JSON.parse(done).action).toBe("clarify");
	});
});

const RESULTS = [
	'- combobox "Search" [ref=e1]',
	'- link "First video 12:34" [ref=e2]:',
	"  - /url: /watch?v=aaa",
	'- link "First video" [ref=e3]:',
	"  - /url: /watch?v=aaa",
	'- link "Channel" [ref=e4]:',
	"  - /url: /@channel",
	'- link "Second video" [ref=e5]:',
	"  - /url: /watch?v=bbb",
].join("\n");

describe("selectors for live pages", () => {
	test("the link's destination is read from the /url line under it", () => {
		const nodes = parseAria(RESULTS);
		expect(
			nodes.filter((n) => n.url !== null).map((n) => [n.ref, n.url]),
		).toEqual([
			["e2", "/watch?v=aaa"],
			["e3", "/watch?v=aaa"],
			["e4", "/@channel"],
			["e5", "/watch?v=bbb"],
		]);
	});

	test("several matches are ambiguous unless the author gives nth; the first is never taken silently", () => {
		const target = { role: "link", urlIncludes: "/watch?v=" };
		expect(resolveTarget(RESULTS, target)).toEqual({ kind: "ambiguous" });
		expect(resolveTarget(RESULTS, { ...target, nth: 0 })).toMatchObject({
			kind: "found",
			ref: "e2",
		});
		expect(resolveTarget(RESULTS, { ...target, nth: 2 })).toMatchObject({
			kind: "found",
			ref: "e5",
		});
		expect(resolveTarget(RESULTS, { ...target, nth: 3 })).toEqual({
			kind: "none",
		});
		expect(
			resolveTarget(RESULTS, { role: "link", urlIncludes: "/shorts/" }),
		).toEqual({ kind: "none" });
		expect(
			resolveTarget(RESULTS, { role: "link", urlIncludes: "/@channel" }),
		).toMatchObject({
			kind: "found",
			ref: "e4",
		});
	});

	test("a name and a destination narrow together", () => {
		expect(
			resolveTarget(RESULTS, {
				role: "link",
				name: "First video",
				urlIncludes: "/watch?v=",
			}),
		).toMatchObject({ kind: "found", ref: "e3" });
	});

	test("nameAnyOf finds the element in either language, roleAnyOf in either role", () => {
		const ja = '- searchbox "検索" [ref=e9]';
		const target = {
			roleAnyOf: ["combobox", "searchbox"],
			nameAnyOf: ["検索", "Search"],
		};
		expect(resolveTarget(RESULTS, target)).toMatchObject({
			kind: "found",
			ref: "e1",
			role: "combobox",
		});
		expect(resolveTarget(ja, target)).toMatchObject({
			kind: "found",
			ref: "e9",
			role: "searchbox",
		});
		expect(resolveTarget(`${ja}\n${RESULTS}`, target)).toEqual({
			kind: "ambiguous",
		});
		expect(resolveTarget('- button "Search" [ref=e1]', target)).toEqual({
			kind: "none",
		});
	});

	test("the schema wants exactly one way to say the role and at most one way to say the name", () => {
		const step = (target: object) => ({
			caseId: "x",
			steps: [{ tool: "browser.page.click", target }],
		});
		const ok = (target: object) => scriptSchema.safeParse(step(target)).success;
		expect(ok({ role: "link", name: "a" })).toBe(true);
		expect(ok({ role: "link", urlIncludes: "/a" })).toBe(true);
		expect(ok({ roleAnyOf: ["a", "b"], nameAnyOf: ["x"], nth: 1 })).toBe(true);
		expect(ok({ role: "link" })).toBe(false);
		expect(ok({ role: "link", name: "a", nameAnyOf: ["b"] })).toBe(false);
		expect(ok({ role: "link", roleAnyOf: ["link"], name: "a" })).toBe(false);
		expect(ok({ name: "a" })).toBe(false);
		expect(ok({ role: "link", name: "a", nth: -1 })).toBe(false);
	});

	test("the scripted inference clarifies on an ambiguity without nth and picks with it", () => {
		const state = messagesFor(RESULTS);
		const run = (target: object) =>
			JSON.parse(
				nextOutput(
					scriptSchema.parse({
						caseId: "x",
						steps: [
							{
								tool: "browser.page.click",
								target,
								args: { effect: "navigate" },
							},
						],
					}),
					prepareStep(state).messages,
				),
			);
		expect(run({ role: "link", urlIncludes: "/watch?v=" })).toMatchObject({
			action: "clarify",
		});
		const picked = run({ role: "link", urlIncludes: "/watch?v=", nth: 0 });
		expect(picked).toMatchObject({
			action: "invoke",
			tool: "browser.page.click",
			arguments: { ref: "e2", effect: "navigate" },
		});
		expect(picked.arguments.element).toBe('link "First video 12:34"');
		expect(parseStep(state, JSON.stringify(picked)).step.kind).toBe("call");
	});
});
