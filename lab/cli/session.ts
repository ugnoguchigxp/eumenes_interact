import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter } from "eumenes-interact";
import { createPlaywrightMcpAdapter } from "eumenes-interact/adapters/playwright-mcp";
import type { LabLogger } from "../host/log.ts";
import { type GuardBlock, startNetGuard } from "../host/net-guard.ts";
import { playwrightLaunch } from "./launch.ts";
import type { BrowserPlatform } from "./platform.ts";

export type BrowserOptions = {
	headed: boolean;
	/** Default `playwright-mcp`. */
	platform?: BrowserPlatform;
	browser?: string;
	executablePath?: string;
	/**
	 * A live session (real sites): the browser is started behind the network guard, so every request it makes
	 * is refused if its host is or resolves to a private address (review 2026-11-04 H1/H2). Off for fixture runs,
	 * whose server is on loopback.
	 */
	netGuard?: boolean | { onBlock?: (b: GuardBlock) => void };
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
	const guard = options.netGuard
		? await startNetGuard(
				typeof options.netGuard === "object" && options.netGuard.onBlock
					? { onBlock: options.netGuard.onBlock }
					: {},
			)
		: null;
	const launch = playwrightLaunch({
		...(options.browser ? { channel: options.browser } : {}),
		...(options.executablePath ? { executablePath: options.executablePath } : {}),
	});
	if (guard) launch.args = [...launch.args, "--proxy-server", guard.url];
	const adapter = createPlaywrightMcpAdapter({
		launch,
		workDir,
		logger,
		correlationId: randomUUID(),
		browser: { mode: "isolated", headless: !options.headed },
	});
	return {
		adapter,
		dispose: async () => {
			await adapter.close();
			await guard?.close();
			await rm(workDir, { recursive: true, force: true });
		},
	};
}
