import { describe, expect, test } from "bun:test";
import { parseMediaInspection } from "../../../packages/eumenes-interact/src/adapters/mcp/inspect.ts";

describe("inspectMedia (2026-11-04)", () => {
	test("reads the playback facts and nothing else", () => {
		const r = parseMediaInspection(
			'```json\n{"found":true,"currentTime":12.3,"duration":600,"paused":false,"ended":false,"readyState":4,"extra":"page text"}\n```',
		);
		expect(r).toEqual({
			found: true,
			currentTime: 12.3,
			duration: 600,
			paused: false,
			ended: false,
			readyState: 4,
		});
	});
	test("no video is a fact, a malformed answer is an error", () => {
		expect(parseMediaInspection('{"found":false}')).toEqual({ found: false });
		expect(() =>
			parseMediaInspection('{"found":true,"currentTime":"x"}'),
		).toThrow();
	});
});
