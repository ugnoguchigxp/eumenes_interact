import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type CaseDef, caseSchema } from "./schema.ts";

/** Absolute path of `lab/fixtures` (no trailing slash). */
export const FIXTURES_DIR = fileURLToPath(
	new URL("../fixtures", import.meta.url),
);

const caseFile = (split: CaseDef["split"]): string =>
	fileURLToPath(new URL(`./${split}/cases.json`, import.meta.url));

/** Validates one case file. Rejects cases whose `split` differs from the file's, and duplicate ids. */
export function parseCases(json: unknown, split: CaseDef["split"]): CaseDef[] {
	const cases = z.array(caseSchema).parse(json);
	const seen = new Set<string>();
	for (const c of cases) {
		if (c.split !== split) {
			throw new Error(`case ${c.id}: split ${c.split} in ${split} file`);
		}
		if (seen.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
		seen.add(c.id);
	}
	return cases;
}

export type LoadOptions = {
	/**
	 * Required, no default. Holdout cases are for the take-back decision only (plan.md §10.2): pass
	 * `true` only for a judging run, never while tuning.
	 */
	includeHoldout: boolean;
};

/** Loads the dev cases, and the holdout cases only when `includeHoldout` is true. */
export async function loadCases(options: LoadOptions): Promise<CaseDef[]> {
	const splits: CaseDef["split"][] = options.includeHoldout
		? ["dev", "holdout"]
		: ["dev"];
	const loaded = await Promise.all(
		splits.map(async (split) =>
			parseCases(JSON.parse(await readFile(caseFile(split), "utf8")), split),
		),
	);
	const all = loaded.flat();
	const ids = new Set(all.map((c) => c.id));
	if (ids.size !== all.length)
		throw new Error("duplicate case id across splits");
	return all;
}
