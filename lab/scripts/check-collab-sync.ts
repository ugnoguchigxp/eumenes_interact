/** Verify the installed collaboration snapshot against the tracked archive provenance. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LAB = resolve(import.meta.dir, "..");
export function collabDrift(): string[] {
	const provenance = JSON.parse(
		readFileSync(join(LAB, "../vendor/collaboration.json"), "utf8"),
	) as { archive: string; sha256: string; files: Record<string, string> };
	const hash = (bytes: Uint8Array) =>
		new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	const errors: string[] = [];
	if (
		hash(readFileSync(join(LAB, "../vendor", provenance.archive))) !==
		provenance.sha256
	)
		errors.push("archive_digest");
	let root = dirname(Bun.resolveSync("eumenes-collaboration", LAB));
	while (!readdirSync(root).includes("package.json")) root = dirname(root);
	for (const [name, expected] of Object.entries(provenance.files)) {
		try {
			if (hash(readFileSync(join(root, name))) !== expected) errors.push(name);
		} catch {
			errors.push(name);
		}
	}
	return errors.sort();
}
if (import.meta.main) {
	const drift = collabDrift();
	if (drift.length) {
		console.error(`collaboration integrity failed: ${drift.join(", ")}`);
		process.exit(1);
	}
	console.log("collaboration archive and installed files: OK");
}
