import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDefinition, type WorkDefinition } from "eumenes-interact";

/** The work definitions the lab ships (plan.md §6): `lab/definitions/*.json`, one revision per file. */
export const DEFINITIONS_DIR = fileURLToPath(
	new URL("../definitions", import.meta.url),
);

/** Parses one file with the package's `parseDefinition`; a bad one is an error with the issue codes. */
export async function readDefinition(path: string): Promise<WorkDefinition> {
	const parsed = parseDefinition(JSON.parse(await readFile(path, "utf8")));
	if (!parsed.ok)
		throw new Error(
			`invalid_definition:${path}:${parsed.issues.map((i) => `${i.path}:${i.code}`).join(",")}`,
		);
	return parsed.definition;
}

export async function loadDefinitions(
	dir: string = DEFINITIONS_DIR,
): Promise<{ file: string; definition: WorkDefinition }[]> {
	const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
	return Promise.all(
		names.map(async (file) => ({
			file,
			definition: await readDefinition(join(dir, file)),
		})),
	);
}
