import { arch, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import type { TrialVersions } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The repository's HEAD, or null before the first commit or without git. Read-only. */
export function packageCommit(cwd: string = REPO_ROOT): string | null {
	try {
		const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
		const head = result.stdout.toString().trim();
		return result.exitCode === 0 && /^[0-9a-f]{40}$/.test(head) ? head : null;
	} catch {
		return null;
	}
}

/**
 * What identifies a trial's environment (plan.md §14). The adapter's tool version is only known after it
 * opens; the run loop fills it in. The browser's own version is not reported by the tool, so the launch
 * choice (channel, own executable, headless) is what is recorded.
 */
export function collectVersions(options: {
	browser: {
		channel: string | null;
		customExecutable: boolean;
		headless: boolean;
	};
	commit?: string | null;
}): TrialVersions {
	return {
		packageCommit:
			options.commit === undefined ? packageCommit() : options.commit,
		coreFormatVersion: 1,
		tool: { name: "@playwright/mcp", version: null },
		os: `${platform()} ${release()} ${arch()}`,
		runtime: `bun ${Bun.version}`,
		browser: options.browser,
	};
}
