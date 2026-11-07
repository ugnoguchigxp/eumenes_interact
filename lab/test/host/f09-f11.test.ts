import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { RawObservation } from "eumenes-interact";
import { FakeBrowser } from "./fake-adapter.ts";
import { setupParts, call, KAEDE, type PartsSetup } from "./parts-harness.ts";

const opened: PartsSetup[] = [];
afterEach(() => {
	for (const s of opened.splice(0)) s.cleanup();
});
async function setup(options: Parameters<typeof setupParts>[0] = {}) {
	const s = await setupParts(options);
	opened.push(s);
	return s;
}
class ChangingBrowser extends FakeBrowser {
	body: string | null = null;
	async choices() {
		return { count: 0, options: "[]" };
	}
	append = "";
	override async observe(): Promise<RawObservation> {
		const o = await super.observe();
		return { ...o, body: (this.body ?? o.body) + this.append };
	}
}
const prepare = (item: string | null, range: "item" | "full" = "item") =>
	call("page.capture", { range, item, phase: "prepare" });
const save = (
	item: string | null,
	confirmation: string,
	range: "item" | "full" = "item",
) =>
	call("page.capture", {
		range,
		item,
		phase: "save",
		confirmation,
		assessment: "Required content is included; unrelated regions are excluded.",
	});

function productIds(s: PartsSetup) {
	return {
		article: s.summary.items.find((i) => i.role === "article")!.item,
		main: s.summary.items.find((i) => i.role === "main")!.item,
		image: s.summary.items.find((i) => i.role === "img")!.item,
	};
}

describe("F11: prepare, inspect, choose again, save", () => {
	test("preparing a broad range exposes unwanted content without writing an image; a narrower range can then be saved", async () => {
		const s = await setup({ start: `${KAEDE}product.html?id=2` });
		const ids = productIds(s);
		const broad = await s.result(prepare(ids.main));
		expect(broad.preview?.target).toBe("main");
		expect(broad.candidates?.some((i) => i.role === "complementary")).toBe(
			true,
		);
		expect(readdirSync(s.dir)).toEqual([]);
		expect(s.adapter.captured).toHaveLength(0);
		const precise = await s.result(prepare(ids.article));
		expect(precise.preview?.text).toContain("660");
		expect(precise.preview?.text).toContain("桜の木");
		expect(precise.candidates?.some((i) => i.role === "complementary")).toBe(
			false,
		);
		const saved = await s.result(
			save(ids.article, precise.preview!.confirmation),
		);
		expect(saved.capture?.target).toContain("article");
		expect(readdirSync(s.dir)).toHaveLength(1);
	});
	test("preparing a child also offers the observed parent for a broader selection", async () => {
		const s = await setup({ start: `${KAEDE}product.html?id=2` });
		const ids = productIds(s);
		const r = await s.result(prepare(ids.image));
		expect(r.candidates?.find((i) => i.item === ids.article)?.role).toBe(
			"article",
		);
		expect(r.candidates?.find((i) => i.item === ids.image)?.parent).toBe(
			ids.article,
		);
		expect(readdirSync(s.dir)).toEqual([]);
	});
	test("save without preparation, with another run's token, or without an assessment never captures", async () => {
		const a = await setup({ start: `${KAEDE}product.html?id=2` });
		const b = await setup({ start: `${KAEDE}product.html?id=2` });
		const ia = productIds(a).article,
			ib = productIds(b).article;
		expect((await a.result(save(ia, "invented"))).code).toBe(
			"capture_confirmation_required",
		);
		const ready = await a.result(prepare(ia));
		expect((await b.result(save(ib, ready.preview!.confirmation))).code).toBe(
			"capture_confirmation_required",
		);
		expect(
			(
				await a.result(
					call("page.capture", {
						range: "item",
						item: ia,
						phase: "save",
						confirmation: ready.preview!.confirmation,
						assessment: null,
					}),
				)
			).code,
		).toBe("capture_confirmation_required");
		expect(a.adapter.captured).toHaveLength(0);
		expect(b.adapter.captured).toHaveLength(0);
	});
	test("changing the selected range invalidates a confirmation", async () => {
		const s = await setup({ start: `${KAEDE}product.html?id=2` });
		const ids = productIds(s);
		const r = await s.result(prepare(ids.article));
		expect((await s.result(save(ids.main, r.preview!.confirmation))).code).toBe(
			"capture_target_changed",
		);
		expect(readdirSync(s.dir)).toEqual([]);
	});
	test("a confirmation is single use even on the same unchanged page", async () => {
		const s = await setup({ start: `${KAEDE}product.html?id=2` });
		const id = productIds(s).article;
		const r = await s.result(prepare(id));
		expect(
			(await s.result(save(id, r.preview!.confirmation))).capture,
		).toBeDefined();
		expect((await s.result(save(id, r.preview!.confirmation))).code).toBe(
			"capture_confirmation_required",
		);
		expect(readdirSync(s.dir)).toHaveLength(1);
	});
	test("an observed content change before save requires a fresh decision", async () => {
		const adapter = new ChangingBrowser();
		const s = await setup({ adapter, start: `${KAEDE}product.html?id=2` });
		const id = productIds(s).article;
		const r = await s.result(prepare(id));
		adapter.append = "\n- paragraph: New content";
		expect((await s.result(save(id, r.preview!.confirmation))).code).toBe(
			"capture_target_changed",
		);
		expect(readdirSync(s.dir)).toEqual([]);
	});
	test("a change while capturing is detected before anything is saved", async () => {
		const adapter = new ChangingBrowser();
		const s = await setup({ adapter, start: `${KAEDE}product.html?id=2` });
		const id = productIds(s).article;
		const r = await s.result(prepare(id));
		const original = adapter.capture.bind(adapter);
		adapter.capture = async (...args) => {
			const image = await original(...args);
			adapter.append = "\n- paragraph: Changed while capturing";
			return image;
		};
		expect((await s.result(save(id, r.preview!.confirmation))).code).toBe(
			"capture_target_changed",
		);
		expect(readdirSync(s.dir)).toEqual([]);
	});
});

describe("F09: scoped, paged neutral candidates", () => {
	test("all candidates beyond the summary limit are reachable in exact document order", async () => {
		const adapter = new ChangingBrowser();
		adapter.body =
			"- main [ref=e1]:\n" +
			Array.from(
				{ length: 75 },
				(_, i) =>
					`  - link "Choice ${i}" [ref=e${i + 2}]:\n    - /url: /choice/${i}`,
			).join("\n");
		const s = await setup({ adapter });
		const names: string[] = [];
		let cursor: string | null = null;
		do {
			const r = await s.result(
				call("page.find", { text: null, role: "link", cursor }),
			);
			names.push(...r.candidates!.map((i) => i.name));
			cursor = r.browse!.cursor;
		} while (cursor);
		expect(names).toEqual(Array.from({ length: 75 }, (_, i) => `Choice ${i}`));
	});
	test("a changed page or query cannot reuse a continuation", async () => {
		const adapter = new ChangingBrowser();
		adapter.body =
			"- main [ref=e1]:\n" +
			Array.from(
				{ length: 30 },
				(_, i) => `  - link "Choice ${i}" [ref=e${i + 2}]`,
			).join("\n");
		const s = await setup({ adapter });
		const r = await s.result(call("page.find", { text: null, role: "link" }));
		expect(r.browse?.cursor).toBeTruthy();
		expect(
			(
				await s.result(
					call("page.find", {
						text: null,
						role: null,
						cursor: r.browse!.cursor,
					}),
				)
			).code,
		).toBe("observation_changed");
		adapter.append = '\n- button "Added" [ref=e100]';
		expect(
			(
				await s.result(
					call("page.find", {
						text: null,
						role: "link",
						cursor: r.browse!.cursor,
					}),
				)
			).code,
		).toBe("observation_changed");
	});
	test("scope uses observed identity even when two blocks share a label", async () => {
		const adapter = new ChangingBrowser();
		adapter.body =
			'- main [ref=e1]:\n  - article "Same" [ref=e2]:\n    - link "First" [ref=e3]\n  - article "Same" [ref=e4]:\n    - link "Second" [ref=e5]';
		const s = await setup({ adapter });
		const blocks = s.summary.items.filter((i) => i.role === "article");
		const r = await s.result(
			call("page.find", { text: null, role: "link", within: blocks[1]!.item }),
		);
		expect(r.candidates?.map((i) => i.name)).toEqual(["Second"]);
		expect(r.candidates?.[0]?.parent).toBe(blocks[1]!.item);
	});
	test("opening an inspected link reports navigation without inferring a sort result", async () => {
		const adapter = new ChangingBrowser();
		adapter.choices = async () => ({
			count: 1,
			options: JSON.stringify([
				{
					text: "Unfamiliar destination",
					href: `${KAEDE}catalog.html?q=x`,
					params: [],
				},
			]),
		});
		const s = await setup({ adapter });
		const found = await s.result(
			call("page.find", { text: null, role: null, inspect: true }),
		);
		adapter.onDispatch = (c, b) => {
			if (c.action === "browser.navigate") b.settleTo = `${KAEDE}catalog.html`;
			return undefined;
		};
		const r = await s.result(
			call("item.open", { item: found.candidates![0]!.item }),
		);
		expect(r.status).toBe("completed");
		expect(r.code).toBeUndefined();
		expect(r.page?.url).toBe(`${KAEDE}catalog.html`);
	});
	test("unknown field wording is kept without adding a lexicon entry", async () => {
		const adapter = new ChangingBrowser();
		adapter.body =
			'- main [ref=e1]:\n  - textbox "Invented label" [ref=e2]\n  - textbox "Unrelated field" [ref=e3]';
		const s = await setup({ adapter, request: "find query" });
		const r = await s.result(
			call("site.search", { query: "query", field: null }),
		);
		expect(r.candidates?.map((i) => i.name)).toEqual([
			"Invented label",
			"Unrelated field",
		]);
		expect(adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
		]);
	});
});
