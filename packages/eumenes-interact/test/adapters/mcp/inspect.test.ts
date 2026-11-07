import { describe, expect, test } from "bun:test";
import {
	INSPECT_TARGET_FUNCTION,
	parseTargetInspection,
} from "../../../src/adapters/mcp/inspect.ts";

/**
 * The element inspection the host's gate and `item.open` read. Its in-page half was checked against real Chrome
 * (design R18: `<a role="menuitem" href="/settings">` → `href: "/settings"`, `href="#"` → "#", no attribute →
 * null, a `<div>` → no href); here the parser's side of the contract.
 */
describe("parseTargetInspection", () => {
	test("an <a>'s href attribute passes as a string or null; other elements carry none", () => {
		expect(
			parseTargetInspection(
				JSON.stringify({
					tag: "a",
					href: "/settings",
					inForm: false,
					submits: false,
				}),
			),
		).toEqual({ tag: "a", href: "/settings", inForm: false, submits: false });
		expect(
			parseTargetInspection(
				JSON.stringify({ tag: "a", href: null, inForm: false, submits: false }),
			),
		).toEqual({ tag: "a", href: null, inForm: false, submits: false });
		expect(
			parseTargetInspection(
				JSON.stringify({ tag: "div", inForm: false, submits: false }),
			),
		).toEqual({ tag: "div", inForm: false, submits: false });
	});

	test("a malformed or oversized href is refused, not passed on", () => {
		for (const href of [42, "x".repeat(201)])
			expect(() =>
				parseTargetInspection(
					JSON.stringify({ tag: "a", href, inForm: false, submits: false }),
				),
			).toThrow("inspect_invalid");
	});

	test("the in-page function reads the href attribute only of <a> and <area>", () => {
		expect(INSPECT_TARGET_FUNCTION).toContain(
			"tag === 'a' || tag === 'area' ? el.getAttribute('href')",
		);
	});
});

describe("neutral DOM choices (F09)", () => {
	test("unfamiliar labels and hidden choices remain reachable, with scope and pagination", async () => {
		const { inspectChoicesFunction } =
			await import("../../../src/adapters/mcp/inspect.ts");
		const elements = Array.from({ length: 35 }, (_, i) => ({
			tagName: "LI",
			textContent: `  Unknown   ${i}  `,
			offsetParent: i % 2 ? {} : null,
			attributes: [],
			getAttribute: () => null,
			getClientRects: () => [],
			closest: () => null,
		}));
		const root = { querySelectorAll: () => elements };
		const run = new Function(
			`return (${inspectChoicesFunction(20, 10, true)})`,
		)();
		const result = run(root);
		expect(result.count).toBe(35);
		expect(
			JSON.parse(result.options).map((o: { text: string }) => o.text),
		).toEqual(Array.from({ length: 10 }, (_, i) => `Unknown ${i + 20}`));
		expect(JSON.parse(result.options)[0].visible).toBe(false);
		expect(() => inspectChoicesFunction(-1)).toThrow();
		expect(() => inspectChoicesFunction(0, 51)).toThrow();
	});
});
