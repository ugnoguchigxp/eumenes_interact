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

/**
 * The Agent Browser MCP launch from the lab's own `agent-browser` dependency (0.39.4): this process's runtime
 * and the package's `bin/agent-browser.js`, never `npx`. The `all` tool profile is offered because the adapter
 * reads an element's box (`agent_browser_get_box`) for its fixed inspection; the adapter itself only calls
 * the tools of its own closed list. The environment is the adapter's to build: it adds PATH and HOME and a session name unique to that
 * adapter (two runs never share a browser), and refuses a launch that carries a session, a profile, a config
 * or anything else that would attach to a browser that already exists, so none is given here.
 */
export function agentBrowserLaunch(): AdapterLaunch {
	const manifest = createRequire(import.meta.url).resolve(
		"agent-browser/package.json",
	);
	return {
		command: process.execPath,
		args: [
			join(dirname(manifest), "bin", "agent-browser.js"),
			"mcp",
			"--tools",
			"all",
		],
	};
}
