import { createHash } from "node:crypto";
import {
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
	mkdirSync,
	copyFileSync,
} from "node:fs";
import { resolve, relative, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkgRoot = join(root, "packages/eumenes-interact");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = (dir) =>
	readdirSync(dir)
		.sort()
		.flatMap((n) => {
			const p = join(dir, n);
			return statSync(p).isDirectory() ? files(p) : [p];
		});
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
mkdirSync(join(pkgRoot, "dist/skills"), { recursive: true });
copyFileSync(
	join(root, "skills/browse/SKILL.md"),
	join(pkgRoot, "dist/skills/browse.md"),
);
// What a host must do, and the vectors it checks itself with (design R08).
mkdirSync(join(pkgRoot, "dist/conformance"), { recursive: true });
copyFileSync(
	join(pkgRoot, "contract/HOST-CONTRACT.md"),
	join(pkgRoot, "dist/HOST-CONTRACT.md"),
);
copyFileSync(
	join(pkgRoot, "contract/host-vectors.json"),
	join(pkgRoot, "dist/conformance/host-vectors.json"),
);
const notices = [];
mkdirSync(join(pkgRoot, "dist/licenses"), { recursive: true });
for (const [name, version] of Object.entries(pkg.dependencies)) {
	const depRoot = join(pkgRoot, "node_modules", name);
	const meta = JSON.parse(readFileSync(join(depRoot, "package.json"), "utf8"));
	if (meta.version !== version || Object.keys(meta.dependencies ?? {}).length)
		throw new Error(`dependency_inventory_incomplete:${name}`);
	const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt"].find((n) =>
		readdirSync(depRoot).includes(n),
	);
	if (!licenseFile || !meta.license)
		throw new Error(`dependency_license_missing:${name}`);
	const license = readFileSync(join(depRoot, licenseFile));
	copyFileSync(
		join(depRoot, licenseFile),
		join(pkgRoot, "dist/licenses", `${name.replaceAll("/", "-")}.txt`),
	);
	notices.push({
		name,
		version,
		license: meta.license,
		repository: meta.repository,
		licenseSha256: digest(license),
	});
}
writeFileSync(
	join(pkgRoot, "dist/third-party.json"),
	JSON.stringify(notices, null, 2) + "\n",
);
const { migrations } = await import(
	pathToFileURL(join(pkgRoot, "dist/sqlite.js")).href
);
const payload = [
	...files(join(pkgRoot, "dist")),
	join(pkgRoot, "LICENSE"),
	join(pkgRoot, "package.json"),
];
/**
 * Everything the payload is made from: the sources, and the build's own inputs (F12), so a change of the
 * compiler settings or of this script changes the identity even when no source file changed.
 */
const source = [
	...files(join(pkgRoot, "src")),
	...files(join(pkgRoot, "contract")),
	join(pkgRoot, "package.json"),
	join(pkgRoot, "tsconfig.build.json"),
	join(root, "tsconfig.json"),
	join(root, "scripts/distribution-manifest.mjs"),
	join(root, "skills/browse/SKILL.md"),
	join(root, "bun.lock"),
];
const sourceHash = digest(
	source
		.map((p) => `${relative(root, p)}\0${digest(readFileSync(p))}`)
		.join("\n"),
);
let commit = null;
try {
	commit = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
} catch {}
const manifest = {
	formatVersion: 1,
	package: pkg.name,
	version: pkg.version,
	contractVersion: 2,
	coreFormatVersion: 1,
	commit,
	sourceTreeSha256: sourceHash,
	lockSha256: digest(readFileSync(join(root, "bun.lock"))),
	skillSha256: digest(readFileSync(join(root, "skills/browse/SKILL.md"))),
	runtimeDependencies: pkg.dependencies,
	migrationSha256: migrations.map((sql) => digest(sql)),
	thirdParty: notices,
	files: Object.fromEntries(
		payload.map((p) => [relative(pkgRoot, p), digest(readFileSync(p))]),
	),
};
writeFileSync(
	join(pkgRoot, "distribution-manifest.json"),
	JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
	`distribution manifest: ${Object.keys(manifest.files).length} files, source ${sourceHash}`,
);
