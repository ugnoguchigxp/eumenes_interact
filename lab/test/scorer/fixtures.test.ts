import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { FIXTURES_DIR, loadCases, parseCases } from "../../cases/load.ts";
import {
	type CaseDef,
	caseSchema,
	type UrlPredicate,
} from "../../cases/schema.ts";

const fixtureFiles = async (): Promise<string[]> =>
	(await readdir(FIXTURES_DIR, { recursive: true, withFileTypes: true }))
		.filter((e) => e.isFile())
		.map((e) => join(e.parentPath, e.name));

const startPath = (start: string): string => start.split("?")[0] as string;

const predicatePaths = (c: CaseDef): string[] => {
	const lists: UrlPredicate[][] = [
		c.expect.effectful,
		c.expect.forbidden,
		c.expect.wrongTargets,
		c.expect.kind === "reach" ? c.expect.final : [],
	];
	return lists.flat().map((p) => p.path);
};

describe("case files", () => {
	test("all case files parse, ids are unique, and the sizes are as planned", async () => {
		const all = await loadCases({ includeHoldout: true });
		const dev = all.filter((c) => c.split === "dev");
		const holdout = all.filter((c) => c.split === "holdout");
		expect(dev.length).toBeGreaterThanOrEqual(10);
		expect(dev.length).toBeLessThanOrEqual(20);
		expect(holdout.length).toBeGreaterThanOrEqual(4);
		expect(holdout.length).toBeLessThanOrEqual(9);
		expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
	});

	test("holdout cases are not loaded without the flag", async () => {
		const dev = await loadCases({ includeHoldout: false });
		expect(dev.length).toBeGreaterThan(0);
		expect(dev.every((c) => c.split === "dev")).toBe(true);
		const all = await loadCases({ includeHoldout: true });
		expect(all.some((c) => c.split === "holdout")).toBe(true);
	});

	test("a case in the wrong split file is rejected", async () => {
		const [first] = await loadCases({ includeHoldout: false });
		expect(() => parseCases([first], "holdout")).toThrow("split dev");
		expect(() => parseCases([first, first], "dev")).toThrow("duplicate");
	});

	test("the schema rejects unsafe or inconsistent cases", async () => {
		const [first] = await loadCases({ includeHoldout: false });
		const withStart = (start: string) =>
			caseSchema.safeParse({ ...first, start }).success;
		expect(withStart("sites/hoshikuzu/base/index.html")).toBe(true);
		expect(withStart("sites/../../secret.html")).toBe(false);
		expect(withStart("/etc/hosts")).toBe(false);
		expect(withStart("https://www.example.com/")).toBe(false);
		expect(
			caseSchema.safeParse({
				...first,
				expect: { kind: "clarify", approval: "required" },
			}).success,
		).toBe(false);
		expect(
			caseSchema.safeParse({
				...first,
				expect: { kind: "refuse", approval: "none" },
				approvalScript: { decision: "grant" },
			}).success,
		).toBe(false);
	});

	test("no budget exceeds Arm 0's limit of 12 model calls", async () => {
		for (const c of await loadCases({ includeHoldout: true })) {
			expect(c.budget.maxModelCalls, c.id).toBeLessThanOrEqual(12);
		}
		const [first] = await loadCases({ includeHoldout: false });
		expect(
			caseSchema.safeParse({ ...first, budget: { maxModelCalls: 13 } }).success,
		).toBe(false);
	});

	test("information-seeking requests carry expected facts", async () => {
		const all = await loadCases({ includeHoldout: true });
		const facts = (id: string): string[] => {
			const c = all.find((x) => x.id === id);
			return c?.expect.kind === "reach" ? c.expect.answerIncludes : [];
		};
		for (const id of [
			"dev-update-base",
			"dev-tab-base",
			"holdout-update-library",
			"holdout-tab-relabel",
		]) {
			expect(facts(id).length, id).toBeGreaterThan(0);
		}
	});

	test("holdout cases use no fixture variant that a dev case uses", async () => {
		const all = await loadCases({ includeHoldout: true });
		const variantsOf = (c: CaseDef): string[] =>
			[
				c.start,
				...(c.staleFrom ? [c.staleFrom] : []),
				...predicatePaths(c),
			].map((p) => p.split("/").slice(0, 3).join("/"));
		const devVariants = new Set(
			all.filter((c) => c.split === "dev").flatMap(variantsOf),
		);
		for (const c of all.filter((x) => x.split === "holdout")) {
			for (const v of variantsOf(c)) {
				expect(devVariants.has(v), `${c.id}: ${v}`).toBe(false);
			}
		}
	});

	test("every case points at fixture files that exist", async () => {
		for (const c of await loadCases({ includeHoldout: true })) {
			const paths = [startPath(c.start), ...predicatePaths(c)];
			if (c.staleFrom) paths.push(c.staleFrom);
			for (const p of paths) {
				expect(existsSync(join(FIXTURES_DIR, p)), `${c.id}: ${p}`).toBe(true);
			}
		}
	});

	test("the case mix covers the planned categories and variants", async () => {
		const all = await loadCases({ includeHoldout: true });
		const has = (key: "category" | "variant", value: string) =>
			all.some((c) => c[key] === value);
		for (const category of [
			"search",
			"select",
			"form",
			"update",
			"tab",
			"approval",
			"ambiguous",
		]) {
			expect(has("category", category), category).toBe(true);
		}
		for (const variant of [
			"base",
			"restructure",
			"relabel",
			"duplicate",
			"delayed",
			"stale",
		]) {
			expect(has("variant", variant), variant).toBe(true);
		}
		expect(all.some((c) => c.expect.kind === "clarify")).toBe(true);
		expect(all.some((c) => c.expect.kind === "refuse")).toBe(true);
	});

	test("a request never names a fixture file or URL", async () => {
		for (const c of await loadCases({ includeHoldout: true })) {
			expect(c.request).not.toMatch(/\.html|file:|https?:|fixtures/);
		}
	});
});

describe("fixtures", () => {
	test("no file refers to an external resource", async () => {
		const files = await fixtureFiles();
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const text = await readFile(f, "utf8");
			expect(text, f).not.toMatch(/https?:\/\//i);
			expect(text, f).not.toMatch(/file:/i);
			expect(text, f).not.toMatch(/(?:src|href|action)\s*=\s*["']\/\//i);
			expect(text, f).not.toMatch(/@import|url\(/i);
			expect(text, f).not.toMatch(
				/\b(?:fetch|XMLHttpRequest|WebSocket|import)\s*\(/,
			);
		}
	});

	test("every script and stylesheet is a local file that exists", async () => {
		for (const f of (await fixtureFiles()).filter((x) => x.endsWith(".html"))) {
			const text = await readFile(f, "utf8");
			for (const m of text.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g)) {
				const ref = m[1] as string;
				expect(ref, f).not.toMatch(/^[a-z][a-z0-9+.-]*:|^\//i);
				expect(existsSync(resolve(dirname(f), ref)), `${f}: ${ref}`).toBe(true);
			}
			for (const m of text.matchAll(/<link\b[^>]*\bhref="([^"]*)"/g)) {
				const ref = m[1] as string;
				expect(ref, f).not.toMatch(/^[a-z][a-z0-9+.-]*:|^\//i);
				expect(existsSync(resolve(dirname(f), ref)), `${f}: ${ref}`).toBe(true);
			}
		}
	});

	test("every link, form action and window.open target is a local page that exists", async () => {
		for (const f of (await fixtureFiles()).filter((x) => x.endsWith(".html"))) {
			const text = await readFile(f, "utf8");
			const refs = [
				...text.matchAll(/<(?:a|form)\b[^>]*\b(?:href|action)="([^"]*)"/g),
				...text.matchAll(/window\.open\("([^"]*)"\)/g),
			].map((m) => m[1] as string);
			for (const ref of refs) {
				expect(ref, f).not.toMatch(/^[a-z][a-z0-9+.-]*:|^\//i);
				const target = resolve(dirname(f), ref.split(/[?#]/)[0] as string);
				expect(extname(target), `${f}: ${ref}`).toBe(".html");
				expect(existsSync(target), `${f}: ${ref}`).toBe(true);
			}
		}
	});
});
