import { test, expect } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	writeFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManualInference } from "../../inference/manual.ts";
const request = {
	messages: [],
	maxOutputTokens: 10,
	signal: new AbortController().signal,
};
test("manual IO uses opaque IDs, private request files and exclusive creation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "interact-manual-boundary-"));
	try {
		for (const id of ["../x", "a/b", "a\\b", "a\nfile"])
			expect(() => createManualInference(dir, id)).toThrow(
				"manual_case_id_invalid",
			);
		writeFileSync(join(dir, "safe-1.res.txt"), "SYNTHETIC_RESPONSE");
		expect(
			(await createManualInference(dir, "safe").complete(request)).kind,
		).toBe("text");
		expect(statSync(join(dir, "safe-1.req.json")).mode & 0o777).toBe(0o600);
		await expect(
			createManualInference(dir, "safe").complete(request),
		).rejects.toThrow();
		writeFileSync(join(dir, "precious"), "KEEP");
		symlinkSync(join(dir, "precious"), join(dir, "linked-1.req.json"));
		await expect(
			createManualInference(dir, "linked").complete(request),
		).rejects.toThrow();
		expect(readFileSync(join(dir, "precious"), "utf8")).toBe("KEEP");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
