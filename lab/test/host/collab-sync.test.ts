import { expect, test } from "bun:test";
import { collabDrift } from "../../scripts/check-collab-sync.ts";

test("the installed eumenes-collaboration matches its source (run `bun install` if not)", () => {
	const drift = collabDrift();
	if (drift === null) return; // no source checkout beside this one
	expect(drift).toEqual([]);
});
