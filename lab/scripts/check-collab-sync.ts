/**
 * The lab uses eumenes-collaboration through a `file:` dependency, which bun installs as a hard-linked copy.
 * An edit that replaces a file in the source (a formatter, an editor's atomic save) breaks the link, and the
 * lab then runs the stale copy. This compares the installed copy's `src/` with the source; on drift, run
 * `bun install` in the repository root.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LAB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function files(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else out.set(relative(root, path), readFileSync(path, "utf8"));
		}
	};
	walk(root);
	return out;
}

/** The source and installed `src/` directories, or null when the source checkout is not beside this one. */
export function collabPaths(): { source: string; installed: string } | null {
	const spec = (
		JSON.parse(readFileSync(join(LAB, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		}
	).dependencies?.["eumenes-collaboration"];
	if (!spec?.startsWith("file:")) return null;
	const source = join(resolve(LAB, spec.slice(5)), "src");
	try {
		statSync(source);
	} catch {
		return null;
	}
	const entry = Bun.resolveSync("eumenes-collaboration", LAB);
	let root = dirname(entry);
	while (!readdirSync(root).includes("package.json")) root = dirname(root);
	return { source, installed: join(root, "src") };
}

/** Files of `src/` that differ, are missing, or are extra in the installed copy; empty when in sync. */
export function collabDrift(): string[] | null {
	const paths = collabPaths();
	if (!paths) return null;
	const a = files(paths.source);
	const b = files(paths.installed);
	const names = new Set([...a.keys(), ...b.keys()]);
	return [...names].filter((n) => a.get(n) !== b.get(n)).sort();
}

if (import.meta.main) {
	const drift = collabDrift();
	if (drift === null) {
		console.log("collab sync: source checkout not found, skipped");
	} else if (drift.length) {
		console.error(
			`collab sync: installed copy differs from source (${drift.join(", ")}); run \`bun install\``,
		);
		process.exit(1);
	} else console.log("collab sync: OK");
}
