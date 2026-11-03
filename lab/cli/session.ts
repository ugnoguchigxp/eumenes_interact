import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter } from "eumenes-interact";
import { createPlaywrightMcpAdapter } from "eumenes-interact/adapters/playwright-mcp";
import type { LabLogger } from "../host/log.ts";
import { agentBrowserLaunch, playwrightLaunch } from "./launch.ts";
import {
	assertBrowserOptions,
	DEFAULT_PLATFORM,
	type BrowserPlatform,
} from "./platform.ts";

export type BrowserOptions = {
	headed: boolean;
	/** Default `playwright-mcp`. */
	platform?: BrowserPlatform;
	/** Playwright MCP only (`assertBrowserOptions`). */
	browser?: string;
	executablePath?: string;
};

/**
 * A fresh isolated Playwright MCP session with its own work directory. `dispose` closes what was started and
 * removes the directory.
 */
export async function createSession(
	options: BrowserOptions,
	logger: LabLogger,
): Promise<{ adapter: PlatformAdapter; dispose(): Promise<void> }> {
	const platform = options.platform ?? DEFAULT_PLATFORM;
	assertBrowserOptions(platform, options);
	const workDir = await mkdtemp(join(tmpdir(), "interact-lab-"));
	const common = { workDir, logger, correlationId: randomUUID() };
	const adapter: PlatformAdapter =
		platform === "agent-browser"
			? await agentBrowserAdapter(common, !options.headed)
			: playwrightAdapter(options, common);
	return {
		adapter,
		dispose: async () => {
			await adapter.close();
			await rm(workDir, { recursive: true, force: true });
		},
	};
}

type Common = { workDir: string; logger: LabLogger; correlationId: string };

/** Loaded on demand: a Playwright run never needs the Agent Browser module. */
async function agentBrowserAdapter(common: Common, headless: boolean) {
	const { createAgentBrowserAdapter } =
		await import("eumenes-interact/adapters/agent-browser");
	return createAgentBrowserAdapter({
		launch: agentBrowserLaunch(),
		...common,
		browser: { headless },
		// The destination of a link is part of the snapshot, as the definition resolver and Arm 0 read it.
		snapshot: { includeUrls: true },
	});
}

function playwrightAdapter(options: BrowserOptions, common: Common) {
	return createPlaywrightMcpAdapter({
		launch: playwrightLaunch({
			...(options.browser ? { channel: options.browser } : {}),
			...(options.executablePath
				? { executablePath: options.executablePath }
				: {}),
		}),
		...common,
		browser: { mode: "isolated", headless: !options.headed },
	});
}
