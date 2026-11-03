/**
 * `bun run check:stack` (plan.md §3.4): reads Eumenes' package.json, tsconfig.json, bunfig.toml [fmt] and
 * .oxlintrc.json read-only and fails when this project's stack differs. Node's version is deliberately
 * not compared (user decision 2026-11-03).
 *
 * Eumenes location: $EUMENES_DIR, default ../eumenes next to this repository.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const eumenes = resolve(process.env.EUMENES_DIR ?? join(root, "../eumenes"));

const SHARED_DEPENDENCIES = [
	"zod",
	"jsonrepair",
	"typescript",
	"oxlint",
	"@types/bun",
	"@types/node",
	"@playwright/mcp",
	"pino",
	"@anthropic-ai/sdk",
] as const;
const COMPILER_OPTIONS = [
	"target",
	"module",
	"moduleResolution",
	"strict",
	"noUncheckedIndexedAccess",
	"noImplicitOverride",
] as const;
const OXLINT_KEYS = ["plugins", "categories", "rules"] as const;

type Json = Record<string, unknown>;
const text = (path: string) => readFileSync(path, "utf8");
/** JSON with `//` line comments (Eumenes' .oxlintrc.json has them). */
const jsonc = (path: string): Json =>
	JSON.parse(text(path).replace(/^\s*\/\/.*$/gm, "")) as Json;
const json = (path: string): Json => JSON.parse(text(path)) as Json;

function dependencies(pkg: Json): Record<string, string> {
	return {
		...(pkg.dependencies as Record<string, string> | undefined),
		...(pkg.devDependencies as Record<string, string> | undefined),
	};
}

/** The [fmt] table without `ignorePatterns` (paths differ per repository). */
function fmtSection(path: string): Json {
	const parsed = Bun.TOML.parse(text(path)) as Json;
	const fmt = { ...(parsed.fmt as Json | undefined) };
	delete fmt.ignorePatterns;
	return fmt;
}

const problems: string[] = [];
const same = (label: string, ours: unknown, theirs: unknown) => {
	if (JSON.stringify(ours) !== JSON.stringify(theirs))
		problems.push(
			`${label}: ours ${JSON.stringify(ours)} / eumenes ${JSON.stringify(theirs)}`,
		);
};

const theirPkg = json(join(eumenes, "package.json"));
const ourRoot = json(join(root, "package.json"));
same("packageManager", ourRoot.packageManager, theirPkg.packageManager);
same("type", ourRoot.type, theirPkg.type);

const theirDeps = dependencies(theirPkg);
const ourPackages = [
	join(root, "package.json"),
	join(root, "packages/eumenes-interact/package.json"),
	join(root, "lab/package.json"),
];
for (const file of ourPackages) {
	const pkg = json(file);
	same(`${file.slice(root.length + 1)} type`, pkg.type, "module");
	for (const [name, version] of Object.entries(dependencies(pkg))) {
		if (version.startsWith("workspace:")) continue;
		if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version))
			problems.push(`${name}: not a pinned version (${version})`);
		if ((SHARED_DEPENDENCIES as readonly string[]).includes(name))
			same(`dependency ${name}`, version, theirDeps[name]);
	}
}
const shipped = dependencies(
	json(join(root, "packages/eumenes-interact/package.json")),
);
for (const name of Object.keys(shipped))
	if (!["zod", "jsonrepair"].includes(name))
		problems.push(`package runtime dependency not allowed: ${name}`);

const theirTs = json(join(eumenes, "tsconfig.json")).compilerOptions as Json;
const ourTs = json(join(root, "tsconfig.json")).compilerOptions as Json;
for (const key of COMPILER_OPTIONS)
	same(`tsconfig ${key}`, ourTs[key], theirTs[key]);

same(
	"bunfig [fmt]",
	fmtSection(join(root, "bunfig.toml")),
	fmtSection(join(eumenes, "bunfig.toml")),
);

const theirLint = jsonc(join(eumenes, ".oxlintrc.json"));
const ourLint = jsonc(join(root, ".oxlintrc.json"));
for (const key of OXLINT_KEYS)
	same(`.oxlintrc ${key}`, ourLint[key], theirLint[key]);

const theirScripts = theirPkg.scripts as Record<string, string>;
const ourScripts = ourRoot.scripts as Record<string, string>;
for (const name of ["lint", "format", "format:check", "typecheck"])
	same(`script ${name}`, ourScripts[name], theirScripts[name]);

if (problems.length) {
	console.error(`check:stack failed against ${eumenes}`);
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log(`check:stack ok (${eumenes})`);
