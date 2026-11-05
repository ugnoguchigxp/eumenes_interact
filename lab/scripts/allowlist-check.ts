/**
 * Prints the action allowlist the chain would use and fails (exit 1) on a bad file: invalid JSON, a
 * non-https origin or one with a path, an unknown action kind. Usage:
 *   bun lab/scripts/allowlist-check.ts [file]   (default: LAB_ACTION_ALLOWLIST or lab/config/action-allowlist.json)
 */
import {
	ACTION_KINDS,
	DEFAULT_ALLOWLIST_PATH,
	loadAllowlist,
} from "../host/allowlist.ts";

const file =
	process.argv[2] || process.env.LAB_ACTION_ALLOWLIST || DEFAULT_ALLOWLIST_PATH;
try {
	const entries = loadAllowlist(file);
	console.log(`allowlist\tok\t${file}`);
	for (const e of entries)
		console.log(`allow\t${e.origin}\t${e.actions.join(",")}`);
	console.log(`kinds\t${Object.keys(ACTION_KINDS).join(",")}`);
} catch (error) {
	console.error(
		`allowlist\tinvalid\t${file}\t${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}
