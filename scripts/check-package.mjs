import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Where the report goes. A gate run writes outside Git (`lab/data/`), so running `verify` never changes a
 * tracked file. `--record <path>` keeps the report as evidence: only under the evidence folders that the
 * formatter ignores, and never over an existing record (a new version gets a new name).
 */
const EVIDENCE_PATH =
	/^docs\/(integration\/[^/]+|reviews\/[^/]+\/implementation\/[^/]+)\.json$/;
function reportTarget(argv) {
	const at = argv.indexOf("--record");
	if (at === -1)
		return {
			path: join(root, "lab/data/package-consumer/latest.json"),
			flag: "w",
		};
	const given = argv[at + 1];
	const inside =
		given === undefined
			? ""
			: relative(root, resolve(root, given)).replaceAll("\\", "/");
	if (!EVIDENCE_PATH.test(inside))
		throw new Error(
			"--record needs a new docs/integration/<name>.json or docs/reviews/<date>/implementation/<name>.json",
		);
	return { path: join(root, inside), flag: "wx" };
}
const target = reportTarget(process.argv.slice(2));
const temp = mkdtempSync(join(tmpdir(), "interact-package-"));
const env = Object.fromEntries(
	["PATH", "HOME", "TMPDIR"].flatMap((k) =>
		process.env[k] === undefined ? [] : [[k, process.env[k]]],
	),
);
try {
	execFileSync("bun", ["pm", "pack", "--destination", temp], {
		cwd: join(root, "packages/eumenes-interact"),
		env,
		stdio: "pipe",
	});
	const archive = join(
		temp,
		readdirSync(temp).find((n) => n.endsWith(".tgz")),
	);
	const contents = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
		.trim()
		.split("\n");
	if (
		contents.some(
			(n) =>
				n.includes("/lab/") || n.includes(".env") || n.includes("node_modules"),
		)
	)
		throw new Error("unwanted_packaged_content");
	const consumer = join(temp, "consumer");
	mkdirSync(consumer);
	writeFileSync(
		join(consumer, "package.json"),
		JSON.stringify({
			private: true,
			type: "module",
			dependencies: { "eumenes-interact": `file:${archive}` },
		}),
	);
	execFileSync("bun", ["install", "--ignore-scripts"], {
		cwd: consumer,
		env,
		stdio: "pipe",
	});
	writeFileSync(
		join(consumer, "consumer.mjs"),
		readFileSync(join(root, "lab/scripts/package-consumer.mjs")),
	);
	const runs = [];
	for (const runtime of ["node", "bun"])
		runs.push(
			JSON.parse(
				execFileSync(runtime, ["consumer.mjs"], {
					cwd: consumer,
					env,
					encoding: "utf8",
				}),
			),
		);
	const report = {
		at: new Date().toISOString(),
		archiveSha256: createHash("sha256")
			.update(readFileSync(archive))
			.digest("hex"),
		contents,
		runs,
	};
	mkdirSync(dirname(target.path), { recursive: true });
	writeFileSync(target.path, JSON.stringify(report, null, 2) + "\n", {
		flag: target.flag,
	});
	console.log(
		JSON.stringify({
			archiveSha256: report.archiveSha256,
			runs,
			report: relative(root, target.path),
		}),
	);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
