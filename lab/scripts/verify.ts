/** Reproducible, credential-free gate. Paid scripts are intentionally separate explicit invocations. */
import { readFileSync } from "node:fs";

/**
 * A gate must not change what Git tracks: a record rewritten by a check would make the tree say something
 * nobody decided. The tree is compared before and after (not required clean), so local edits do not fail it:
 * the file list, and the content of every changed and untracked file, so a gate that rewrites a file that was
 * already modified is caught too. Without Git (an unpacked archive) the comparison is skipped and said so.
 */
function git(args: string[]): Uint8Array | null {
	const run = Bun.spawnSync(["git", ...args], {
		stdout: "pipe",
		stderr: "ignore",
	});
	return run.exitCode === 0 ? run.stdout : null;
}
type TreeState = { status: string; digest: string };
function treeState(): TreeState | null {
	const status = git(["status", "--porcelain=v1", "-uall"]);
	const diff = git(["diff", "HEAD", "--binary", "--no-ext-diff"]);
	const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
	if (status === null || diff === null || untracked === null) return null;
	const hash = new Bun.CryptoHasher("sha256").update(status).update(diff);
	for (const path of new TextDecoder()
		.decode(untracked)
		.split("\0")
		.filter(Boolean)) {
		hash.update(`\0${path}\0`);
		try {
			hash.update(readFileSync(path));
		} catch {
			hash.update("(unreadable)");
		}
	}
	return {
		status: new TextDecoder().decode(status),
		digest: hash.digest("hex"),
	};
}

const checks = [
	["typecheck"],
	["typecheck:core"],
	["lint"],
	["format:check"],
	["check:collab"],
	["test"],
	["check:dist"],
	["check:package"],
];
const before = treeState();
if (before === null)
	console.log("verify: no Git tree, the unchanged-tree check is skipped");
for (const args of checks) {
	const child = Bun.spawn(["bun", "run", ...args], {
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await child.exited;
	if (code) process.exit(code);
}
if (process.env.LAB_BROWSER_TESTS === "1") {
	const child = Bun.spawn(
		["bun", "test", "lab/test/host/net-guard.browser.test.ts"],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if (await child.exited) process.exit(1);
}
const after = treeState();
if (before !== null && after?.digest !== before.digest) {
	console.error(
		"verify: the gates changed the Git tree (files or their content)\n--- before\n" +
			before.status +
			"--- after\n" +
			(after?.status ?? "(git failed)\n"),
	);
	process.exit(1);
}
console.log(
	"verify: all requested gates passed; Eumenes integration and paid API evaluation are separate recorded gates",
);
