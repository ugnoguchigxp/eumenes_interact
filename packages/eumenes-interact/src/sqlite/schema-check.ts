import type { InteractDb } from "../contracts/db.ts";
import { guarded, readText } from "./db.ts";
import { InteractStoreError } from "./errors.ts";
import { INTERACT_TABLES } from "./migrations.ts";

/**
 * Entry check for hosts: every `interact_*` table exists, i.e. the host applied the package migrations.
 * Content equality of the migrations is the host's migration test (the SQL list is public).
 */
export function assertInteractSchema(db: InteractDb): void {
	const rows = guarded(() =>
		db
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'interact\\_%' ESCAPE '\\'",
			)
			.all(),
	);
	const present = new Set(rows.map((row) => readText(row, "name")));
	for (const table of INTERACT_TABLES) {
		if (!present.has(table)) throw new InteractStoreError("schema_missing");
	}
}
