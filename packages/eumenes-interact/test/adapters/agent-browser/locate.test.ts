import { expect, test } from "bun:test";
import {
	locateScript,
	parseBox,
	parseLocated,
	probePoint,
	type Box,
} from "../../../src/adapters/agent-browser/locate.ts";

/** A rectangle-only DOM: just what the locate script reads. */
class Rect {
	parentElement: Rect | null = null;
	constructor(
		readonly id: string,
		private box: Box,
		parent: Rect | null = null,
	) {
		this.parentElement = parent;
	}
	getBoundingClientRect() {
		const { x, y, width, height } = this.box;
		return { left: x, top: y, right: x + width, bottom: y + height };
	}
}

const BOX: Box = { x: 100, y: 50, width: 200, height: 40 };

/** Runs the locate script (around a body that reports the element's id) on a page whose point hit is `hit`. */
function locate(
	box: Box,
	hit: Rect | null,
	view = { innerWidth: 1280, innerHeight: 720 },
) {
	const probes: [number, number][] = [];
	const script = locateScript("(el) => ({ id: el.id })", box);
	const result = new Function("window", "document", `return ${script}`)(view, {
		elementFromPoint: (x: number, y: number) => {
			probes.push([x, y]);
			return hit;
		},
	});
	return { answer: JSON.parse(result), probes };
}

test("the probe point is inside the box, near its start, and the script gets only numbers", () => {
	expect(probePoint(BOX)).toEqual({ x: 108, y: 58 });
	expect(probePoint({ x: 10, y: 20, width: 6, height: 2 })).toEqual({
		x: 13,
		y: 21,
	});
	expect(locate(BOX, new Rect("a", BOX)).probes).toEqual([[108, 58]]);
});

test("the element with the box's rectangle is found, from the hit element or one of its ancestors", () => {
	const target = new Rect("target", BOX);
	expect(locate(BOX, target).answer).toEqual({
		match: true,
		value: { id: "target" },
	});
	// Within 1px on every edge.
	const near = new Rect("near", {
		x: 100.9,
		y: 49.2,
		width: 199.5,
		height: 40.8,
	});
	expect(locate(BOX, near).answer).toMatchObject({ match: true });
	// The probe hits a child; the parent has the rectangle.
	const child = new Rect(
		"child",
		{ x: 104, y: 52, width: 30, height: 20 },
		target,
	);
	expect(locate(BOX, child).answer).toEqual({
		match: true,
		value: { id: "target" },
	});
});

test("no match when something else covers the point, the rectangle differs or nothing is there", () => {
	const overlay = new Rect("overlay", { x: 0, y: 0, width: 1280, height: 720 });
	expect(locate(BOX, overlay).answer).toEqual({ match: false });
	// Page coordinates instead of viewport ones: the rectangle is somewhere else.
	const scrolled = new Rect("scrolled", {
		x: 100,
		y: 50 - 300,
		width: 200,
		height: 40,
	});
	expect(locate(BOX, scrolled).answer).toEqual({ match: false });
	// 2px off on one edge.
	const off = new Rect("off", { x: 100, y: 50, width: 200, height: 42.5 });
	expect(locate(BOX, off).answer).toEqual({ match: false });
	expect(locate(BOX, null).answer).toEqual({ match: false });
});

test("a probe point outside the viewport or at a negative coordinate is no match and nothing is looked up", () => {
	const hit = new Rect("a", BOX);
	for (const box of [
		{ x: 1272, y: 50, width: 200, height: 40 },
		{ x: 100, y: 715, width: 200, height: 40 },
		{ x: -20, y: 50, width: 40, height: 40 },
		{ x: 100, y: -30, width: 40, height: 20 },
	]) {
		const { answer, probes } = locate(box, hit);
		expect(answer, JSON.stringify(box)).toEqual({ match: false });
		expect(probes).toEqual([]);
	}
	// Inside the viewport it is looked up.
	expect(
		locate({ x: 1200, y: 600, width: 50, height: 50 }, null).probes,
	).toHaveLength(1);
});

const answer = (text: string) => ({
	content: [{ type: "text" as const, text }],
});

test("the box is read from the tool's JSON; anything that is not a usable box is unsupported", () => {
	expect(
		parseBox(
			answer(
				'{\n  "data": { "height": 32, "lifecycle": {}, "width": 423, "x": 306, "y": 17 },\n  "error": null,\n  "success": true\n}',
			),
		),
	).toEqual({ x: 306, y: 17, width: 423, height: 32 });
	expect(parseBox(answer('{"x":0,"y":-4.5,"width":1,"height":2}'))).toEqual({
		x: 0,
		y: -4.5,
		width: 1,
		height: 2,
	});
	for (const bad of [
		"",
		"no",
		"[]",
		"null",
		'{"data":{"x":1,"y":1,"width":0,"height":1}}',
		'{"data":{"x":1,"y":1,"width":1,"height":-1}}',
		'{"data":{"x":"1","y":1,"width":1,"height":1}}',
		'{"data":{"x":1e999,"y":1,"width":1,"height":1}}',
		'{"data":{"x":1,"y":1,"width":1e999,"height":1}}',
		'{"data":{"x":1,"y":-1e999,"width":1,"height":1}}',
		'{"data":{"x":1e8,"y":1,"width":1,"height":1}}',
		'{"data":{"y":1,"width":1,"height":1}}',
	])
		expect(() => parseBox(answer(bad)), bad).toThrow(
			expect.objectContaining({ code: "unsupported", dispatched: false }),
		);
});

test("only validated numbers reach the script text, whatever the page reports", () => {
	const script = locateScript("(el) => el.id", {
		x: 1.25,
		y: -3,
		width: 7,
		height: 9,
	});
	expect(script).toContain(
		'const box = {"x":1.25,"y":-3,"width":7,"height":9};',
	);
	expect(script).toContain("const px = 4.75;");
	expect(script).toContain("const py = 1.5;");
});

test("a located answer is the function's result or nothing; other shapes are errors", () => {
	expect(parseLocated('{"match":true,"value":{"a":1}}')).toBe('{"a":1}');
	expect(parseLocated('{"match":false}')).toBeUndefined();
	for (const bad of [
		"",
		"oops",
		"[]",
		"null",
		"{}",
		'{"match":true}',
		'{"match":"yes"}',
	])
		expect(() => parseLocated(bad), bad).toThrow(
			expect.objectContaining({
				code: "mcp_response_unrecognized",
				dispatched: false,
			}),
		);
});
