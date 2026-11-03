import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AdapterLaunch } from "eumenes-interact";

/**
 * The Playwright MCP launch built from the lab's own `@playwright/mcp` dependency (its version is the one
 * Eumenes pins, plan.md §3.4): this process's runtime and the package's `cli.js`, never `npx`. The adapter
 * adds `--isolated`, `--headless`, the output directory and the mute config itself and refuses any launch
 * argument that attaches to an existing browser.
 */
export function playwrightLaunch(options: {
	channel?: string;
	executablePath?: string;
}): AdapterLaunch {
	const manifest = createRequire(import.meta.url).resolve(
		"@playwright/mcp/package.json",
	);
	return {
		command: process.execPath,
		args: [
			join(dirname(manifest), "cli.js"),
			...(options.channel ? ["--browser", options.channel] : []),
			...(options.executablePath
				? ["--executable-path", options.executablePath]
				: []),
		],
	};
}
