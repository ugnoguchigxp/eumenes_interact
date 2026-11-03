import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter } from "eumenes-interact";
import { createPlaywrightMcpAdapter } from "eumenes-interact/adapters/playwright-mcp";
import type { LabLogger } from "../host/log.ts";
import { playwrightLaunch } from "./launch.ts";

export type BrowserOptions = {
	headed: boolean;
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
	const workDir = await mkdtemp(join(tmpdir(), "interact-lab-"));
	const adapter = createPlaywrightMcpAdapter({
		launch: playwrightLaunch({
			...(options.browser ? { channel: options.browser } : {}),
			...(options.executablePath
				? { executablePath: options.executablePath }
				: {}),
		}),
		workDir,
		logger,
		correlationId: randomUUID(),
		browser: { mode: "isolated", headless: !options.headed },
	});
	return {
		adapter,
		dispose: async () => {
			await adapter.close();
			await rm(workDir, { recursive: true, force: true });
		},
	};
}
