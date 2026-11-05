import { test, expect } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	readFileSync,
	statSync,
	symlinkSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservationSink } from "../../host/observations.ts";

test("kept page data cannot traverse, follow an output symlink or replace existing data", () => {
	const dir = mkdtempSync(join(tmpdir(), "interact-observation-boundary-"));
	const outside = mkdtempSync(join(tmpdir(), "interact-observation-outside-"));
	const body = { body: "SYNTHETIC_PRIVATE_MARKER" };
	try {
		const sink = createObservationSink(dir);
		expect(() => sink("../escape", 1, body)).toThrow("observation_id_invalid");
		expect(() => sink("run", 0, body)).toThrow("observation_id_invalid");
		symlinkSync(outside, join(dir, "linked"));
		expect(() => sink("linked", 1, body)).toThrow("observation_dir_changed");
		mkdirSync(join(dir, "run"));
		writeFileSync(join(outside, "precious"), "KEEP");
		symlinkSync(join(outside, "precious"), join(dir, "run", "1.txt"));
		expect(() => sink("run", 1, body)).toThrow();
		expect(readFileSync(join(outside, "precious"), "utf8")).toBe("KEEP");
		sink("fresh", 1, body);
		const path = join(dir, "fresh", "1.txt");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "fresh")).mode & 0o777).toBe(0o700);
		expect(() => sink("fresh", 1, { body: "REPLACEMENT" })).toThrow();
		expect(readFileSync(path, "utf8")).toContain(body.body);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});
