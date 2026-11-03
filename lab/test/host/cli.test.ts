import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanSummary, parseInputs } from "../../cli/task-command.ts";
import type { DefinitionRunResult } from "../../host/definition-run.ts";

const MAIN = join(import.meta.dir, "../../cli/main.ts");
const KNOWLEDGE = join(import.meta.dir, "../../knowledge");
let dir = "";
let db = "";
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "interact-cli-test-"));
	db = join(dir, "interact.sqlite");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cli = (...args: string[]) => {
	const done = Bun.spawnSync(["bun", MAIN, ...args, "--db", db], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: done.exitCode,
		out: done.stdout.toString(),
		err: done.stderr.toString(),
	};
};

describe("--input", () => {
	test("the first = splits, a value may contain =, and a repeated key is refused", () => {
		expect(parseInputs(["query=a=b", "other="])).toEqual({
			query: "a=b",
			other: "",
		});
		expect(() => parseInputs(["query"])).toThrow("input_must_be_key=value");
		expect(() => parseInputs(["=x"])).toThrow("input_must_be_key=value");
		expect(() => parseInputs(["q=1", "q=2"])).toThrow("input_given_twice:q");
	});
});

describe("task and knowledge commands", () => {
	test("task list shows the four samples with their inputs and origins", () => {
		const r = cli("task", "list");
		expect(r.code).toBe(0);
		const lines = r.out.trim().split("\n");
		// The revision of a sample changes when its data does: the ids are what is fixed.
		expect(lines.map((l) => l.split("\t")[0]?.replace(/@\d+$/, ""))).toEqual([
			"biggo-product",
			"gizmodo-article",
			"slashdot-story",
			"wikipedia-article",
		]);
		expect(r.out).toContain("inputs: query");
		expect(r.out).toContain("origins: https://*.slashdot.org");
	});

	test("knowledge import is idempotent and knowledge list shows what is stored", () => {
		const files = ["wikipedia.json", "slashdot.json"].map((f) =>
			join(KNOWLEDGE, f),
		);
		const first = cli("knowledge", "import", ...files);
		expect(first.code).toBe(0);
		expect(first.out).toContain(
			"https://ja.wikipedia.org\tprofiles 3\tcreated 3\trevised 0\tunchanged 0",
		);
		const second = cli("knowledge", "import", ...files);
		expect(second.out).toContain("created 0\trevised 0\tunchanged 3");
		const list = cli(
			"knowledge",
			"list",
			"--origin",
			"https://ja.wikipedia.org",
		);
		expect(list.code).toBe(0);
		expect(list.out).toContain("article/article.body\trev 1");
		expect(list.out).toContain("candidate\tstructure");
		expect(
			cli("knowledge", "list", "--origin", "https://nope.example").out,
		).toBe("");
		expect(cli("knowledge", "import").code).toBe(1);
	});

	test("an unknown definition is an error before anything starts", () => {
		const r = cli("task", "run", "no-such-definition", "--input", "query=x");
		expect(r.code).toBe(1);
		expect(r.err).toContain("definition_not_found:no-such-definition");
	});

	test("missing input is refused with exit code 2 and a JSON result, before any browser is started", () => {
		const r = cli("task", "run", "wikipedia-article", "--json");
		expect(r.code).toBe(2);
		const result = JSON.parse(r.out) as DefinitionRunResult;
		expect(result).toMatchObject({
			ok: false,
			status: "rejected",
			runId: null,
			definition: { id: "wikipedia-article", revision: expect.any(Number) },
			steps: [],
			extracts: {},
		});
		expect(result.issues?.map((i) => i.code)).toContain("missing_input");
		const human = cli("task", "run", "wikipedia-article");
		expect(human.code).toBe(2);
		expect(human.out).toContain("status\trejected");
	});
});

describe("the human summary", () => {
	test("prints steps, the extract and any approval, with page text made safe", () => {
		const result: DefinitionRunResult = {
			ok: false,
			status: "needs_input",
			code: "approval_required",
			definition: { id: "d", revision: 1, digest: "abcdef0123456789" },
			platform: "playwright-mcp",
			tool: { name: "@playwright/mcp", version: "0.0.83" },
			inputs: { query: "q" },
			finalUrl: "https://a.test/\u001b[2J",
			steps: [
				{
					id: "open",
					action: "browser.navigate",
					status: "confirmed",
					durationMs: 1,
				},
				{
					id: "go",
					action: "page.click",
					status: "needs_input",
					code: "approval_required",
					durationMs: 2,
				},
			],
			extracts: {
				read: {
					url: "https://a.test/",
					title: "T",
					text: "line1\nFAKE: line2\u001b[31m",
					charCount: 99,
					truncated: true,
					root: "main",
				},
			},
			runId: "r",
			approval: {
				action: "click",
				page: "https://a.test/",
				element: "ボタン",
				summary: "s",
			},
		};
		const lines = humanSummary(result);
		for (const bad of ["\u001b", "\r"])
			expect(lines.join("\n")).not.toContain(bad);
		expect(lines).toContain("status\tneeds_input (approval_required)\tnot ok");
		expect(lines).toContain(
			"  go\tpage.click\tneeds_input (approval_required)",
		);
		expect(lines.find((l) => l.startsWith("extract read"))).toContain(
			"99 chars (truncated)",
		);
		expect(lines.some((l) => l.startsWith("needs approval\tclick"))).toBe(true);
		// The extract is one line: a newline in a page cannot start a forged line.
		expect(lines.filter((l) => l.startsWith("FAKE")).length).toBe(0);
	});
});
