import type { Database } from "bun:sqlite";
import { importSeed, listKnowledge, readSeed } from "../knowledge/seed.ts";
import { LAB_OWNER } from "../host/run.ts";

/** `knowledge import <files…>`: idempotent; one line per origin. */
export async function knowledgeImport(
	db: Database,
	files: readonly string[],
): Promise<string[]> {
	if (files.length === 0) throw new Error("knowledge_import_needs_files");
	const lines: string[] = [];
	const nowIso = new Date().toISOString();
	for (const file of files)
		for (const r of importSeed(db, LAB_OWNER, await readSeed(file), nowIso))
			lines.push(
				`${r.origin}\tprofiles ${r.profiles}\tcreated ${r.created}\trevised ${r.revised}\tunchanged ${r.unchanged}`,
			);
	return lines;
}

/** `knowledge list [--origin]`: what is stored, with each candidate's status. */
export function knowledgeList(db: Database, origin?: string): string[] {
	return listKnowledge(db, LAB_OWNER, origin).flatMap((k) => [
		k.origin,
		...k.profiles.map((p) => `  profile ${p.name}\t${p.urlHint ?? "-"}`),
		...k.objects.flatMap((o) => [
			`  ${o.profile}/${o.logicalName}\trev ${o.revision}`,
			...o.candidates.map(
				(c) => `    ${c.status}\t${c.kind}\t${JSON.stringify(c.fields)}`,
			),
		]),
	]);
}
