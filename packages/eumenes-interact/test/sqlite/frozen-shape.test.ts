import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { migrations } from "../../src/sqlite/index.ts";

/**
 * Records each migration body's sha256 so an edit is visible in review. Before the first bring-back
 * to Eumenes the migrations may still be rewritten: update this list in the same change. After the
 * bring-back a recorded entry never changes; only new entries are appended (plan.md §3.3).
 */
const RECORDED_SHA256: readonly string[] = [
	"949e05a671d5758db8deba1fbcbd04abcec7a6a09e0feaa05b996d637ce2fb7b",
];

test("migration bodies match the recorded sha256 list", () => {
	const actual = migrations.map((sql) =>
		createHash("sha256").update(sql).digest("hex"),
	);
	expect(actual).toEqual([...RECORDED_SHA256]);
});
