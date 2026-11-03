import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES_DIR, loadCases } from "../../cases/load.ts";
import { type CaseDef, caseSchema } from "../../cases/schema.ts";

const all = await loadCases({ includeHoldout: true });
const split = (s: CaseDef["split"]) => all.filter((c) => c.split === s);

const page = (path: string): Promise<string> =>
	readFile(join(FIXTURES_DIR, path), "utf8");

const reach = (c: CaseDef) => (c.expect.kind === "reach" ? c.expect : null);

describe("screenshot cases", () => {
	test("every screenshot case asks for captures, and dev covers all three ranges", () => {
		for (const c of all.filter((x) => x.category === "screenshot")) {
			expect(reach(c)?.captures, c.id).toBeDefined();
		}
		const ranges = new Set(
			split("dev")
				.filter((c) => c.category === "screenshot")
				.map((c) => reach(c)?.captures?.range),
		);
		expect([...ranges].sort()).toEqual(["full", "item", "viewport"]);
		expect(split("holdout").some((c) => c.category === "screenshot")).toBe(
			true,
		);
	});

	test("captures belong to reach cases, with a positive minimum and a known range", async () => {
		const base = all.find((c) => c.id === "dev-capture-results") as CaseDef;
		const parse = (expectValue: unknown) =>
			caseSchema.safeParse({ ...base, expect: expectValue }).success;
		const reachWith = (captures: unknown) => ({
			...base.expect,
			captures,
		});
		expect(parse(reachWith({ min: 1, range: "item" }))).toBe(true);
		expect(parse(reachWith({ min: 0 }))).toBe(false);
		expect(parse(reachWith({ min: 1, range: "element" }))).toBe(false);
		expect(parse(reachWith({ min: 1, extra: true }))).toBe(false);
		expect(
			parse({ kind: "clarify", approval: "none", captures: { min: 1 } }),
		).toBe(false);
	});

	test("an item capture is asked on a page that has a labelled region for the item, and the full one on a tall page", async () => {
		for (const c of all.filter((x) => reach(x)?.captures?.range === "item")) {
			const final = reach(c)?.final[0]?.path as string;
			expect(await page(final), c.id).toMatch(/<article[^>]*aria-label=/);
		}
		const full = all.find((c) => reach(c)?.captures?.range === "full");
		const html = await page(reach(full as CaseDef)?.final[0]?.path as string);
		expect(html.match(/class="tall"/g)?.length).toBeGreaterThanOrEqual(4);
	});
});

describe("form filling cases", () => {
	test("the multi-field forms have every control type, and the expected query uses their names", async () => {
		for (const id of ["dev-form-multifield", "holdout-form-register-library"]) {
			const c = all.find((x) => x.id === id) as CaseDef;
			expect(c.expect.approval, id).toBe("required");
			const final = reach(c)?.final[0];
			expect(final).toBeDefined();
			const dir = c.start.split("/").slice(0, 3).join("/");
			const html = await page(c.start);
			for (const type of ["text", "email", "checkbox", "radio"]) {
				expect(html, `${id} ${type}`).toMatch(
					type === "text"
						? /<input[^>]*name="fullname"/
						: new RegExp(`<input[^>]*type="${type}"`),
				);
			}
			expect(html, id).toMatch(/<select/);
			for (const key of Object.keys(final?.query ?? {})) {
				expect(html, `${id}: ${key}`).toContain(`name="${key}"`);
			}
			expect(final?.path.startsWith(dir), id).toBe(true);
			expect(Object.keys(final?.query ?? {}).length, id).toBe(5);
		}
	});

	test("the missing-value case omits a required control the form cannot default", async () => {
		const c = all.find((x) => x.id === "dev-form-multifield-ask") as CaseDef;
		expect(c.expect.kind).toBe("clarify");
		expect(c.expect.forbidden.length).toBeGreaterThan(0);
		const html = await page(c.start);
		expect(html).toMatch(/type="radio"[^>]*name="delivery"[^>]*required/);
		expect(html).not.toMatch(/\bchecked\b/);
		expect(c.request).not.toMatch(/急ぎ|通常/);
	});
});

describe("content reading cases", () => {
	test("each fact is only in the table of the page the answer is read from", async () => {
		const reading = all.filter((c) => c.category === "read");
		expect(split("dev").some((c) => c.category === "read")).toBe(true);
		expect(split("holdout").some((c) => c.category === "read")).toBe(true);
		for (const c of reading) {
			const e = reach(c);
			const facts = e?.answerIncludes ?? [];
			expect(facts.length, c.id).toBeGreaterThan(0);
			const html = await page(e?.final[0]?.path as string);
			const table = html.match(/<table[\s\S]*?<\/table>/)?.[0] ?? "";
			const outside = html.replace(table, "");
			expect(table, c.id).not.toBe("");
			for (const fact of facts) {
				expect(table, `${c.id}: ${fact}`).toContain(fact);
				expect(outside, `${c.id}: ${fact}`).not.toContain(fact);
				expect(c.request, `${c.id}: ${fact}`).not.toContain(fact);
			}
		}
	});
});
