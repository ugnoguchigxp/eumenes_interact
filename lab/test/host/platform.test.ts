import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentBrowserAdapter,
	type AgentBrowserDeps,
} from "eumenes-interact/adapters/agent-browser";

type SessionLaunch = Parameters<
	NonNullable<AgentBrowserDeps["startSession"]>
>[0];
import { silentLabLogger } from "../../host/log.ts";
import { agentBrowserLaunch, playwrightLaunch } from "../../cli/launch.ts";
import { parsePlatforms } from "../../cli/compare-command.ts";
import {
	DEFAULT_PLATFORM,
	assertBrowserOptions,
	parsePlatform,
} from "../../cli/platform.ts";

const MAIN = `${import.meta.dir}/../../cli/main.ts`;
const cli = (...args: string[]) => {
	const done = Bun.spawnSync(["bun", MAIN, ...args, "--db", ":memory:"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: done.exitCode,
		err: done.stderr.toString(),
		out: done.stdout.toString(),
	};
};

describe("platform selection", () => {
	test("playwright-mcp is the default and an unknown platform is refused", () => {
		expect(DEFAULT_PLATFORM).toBe("playwright-mcp");
		expect(parsePlatform(undefined)).toBe("playwright-mcp");
		expect(parsePlatform("agent-browser")).toBe("agent-browser");
		expect(() => parsePlatform("agent-desktop")).toThrow("invalid_platform");
		expect(() => parsePlatform("chrome")).toThrow("invalid_platform");
	});

	test("--browser and --executable-path are Playwright-only and refused for agent-browser, not ignored", () => {
		expect(() =>
			assertBrowserOptions("agent-browser", { browser: "chrome" }),
		).toThrow("browser_options_are_playwright_only");
		expect(() =>
			assertBrowserOptions("agent-browser", { executablePath: "/x" }),
		).toThrow("browser_options_are_playwright_only");
		expect(() => assertBrowserOptions("agent-browser", {})).not.toThrow();
		expect(() =>
			assertBrowserOptions("playwright-mcp", {
				browser: "chrome",
				executablePath: "/x",
			}),
		).not.toThrow();
	});

	test("--platforms is a list of distinct valid platforms", () => {
		expect(parsePlatforms("playwright-mcp,agent-browser")).toEqual([
			"playwright-mcp",
			"agent-browser",
		]);
		expect(parsePlatforms("agent-browser")).toEqual(["agent-browser"]);
		expect(() => parsePlatforms("agent-browser,agent-browser")).toThrow(
			"platforms_must_be_distinct",
		);
		expect(() => parsePlatforms("agent-browser,nope")).toThrow(
			"invalid_platform",
		);
	});

	test("the CLI refuses a bad combination before it starts anything", () => {
		const mixed = cli(
			"task",
			"run",
			"wikipedia-article",
			"--platform",
			"agent-browser",
			"--browser",
			"chrome",
		);
		expect(mixed.code).toBe(1);
		expect(mixed.err).toContain("browser_options_are_playwright_only");
		expect(
			cli("task", "run", "wikipedia-article", "--platform", "nope").err,
		).toContain("invalid_platform");
		const noLive = cli(
			"compare",
			"--platforms",
			"playwright-mcp,agent-browser",
		);
		expect(noLive.code).toBe(1);
		expect(noLive.err).toContain("live_needs_include_live");
		expect(cli("compare").err).toContain("compare_needs_platforms");
		expect(
			cli("compare", "--platforms", "playwright-mcp", "--split", "holdout").err,
		).toContain("compare_split_must_be_dev");
	});
});

describe("the launches", () => {
	test("Agent Browser: this runtime, the package's own bin, the MCP command with the two tool profiles, no npx", () => {
		const launch = agentBrowserLaunch();
		expect(launch.command).toBe(process.execPath);
		expect(launch.args[0]).toMatch(
			/node_modules\/agent-browser\/bin\/agent-browser\.js$/,
		);
		expect(existsSync(launch.args[0]!)).toBe(true);
		expect(launch.args.slice(1)).toEqual(["mcp", "--tools", "all"]);
		expect(JSON.stringify(launch)).not.toContain("npx");
	});

	test("Agent Browser: the adapter accepts the launch and gives each adapter a session of its own, with PATH and HOME", async () => {
		const dir = mkdtempSync(join(tmpdir(), "interact-ab-launch-test-"));
		try {
			const seen: SessionLaunch[] = [];
			for (const name of ["a", "b"]) {
				const adapter = createAgentBrowserAdapter(
					{
						launch: agentBrowserLaunch(),
						workDir: join(dir, name),
						logger: silentLabLogger,
						correlationId: name,
						browser: { headless: true },
					},
					{
						startSession: (launch) => {
							seen.push(launch);
							throw new Error("stop here: only the launch is looked at");
						},
					},
				);
				await adapter.open(new AbortController().signal).catch(() => undefined);
			}
			// Both launches passed the adapter's refusal of anything that attaches to an existing browser.
			expect(seen).toHaveLength(2);
			const [a, b] = seen;
			expect(a!.command).toBe(process.execPath);
			expect(a!.args.slice(1, 4)).toEqual(["mcp", "--tools", "all"]);
			expect(a!.env.AGENT_BROWSER_SESSION).toMatch(/^[A-Za-z0-9._-]+$/);
			expect(a!.env.AGENT_BROWSER_SESSION).not.toBe(
				b!.env.AGENT_BROWSER_SESSION,
			);
			expect(a!.env.PATH).toBe(process.env.PATH!);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("Agent Browser: the host's own launch carries no environment that would select or attach to a browser", () => {
		expect(agentBrowserLaunch().env).toBeUndefined();
	});

	test("Playwright MCP: unchanged, with the browser options it owns", () => {
		const plain = playwrightLaunch({});
		expect(plain.args).toHaveLength(1);
		expect(plain.args[0]).toMatch(/@playwright\/mcp\/cli\.js$/);
		expect(
			playwrightLaunch({ channel: "chrome", executablePath: "/x" }).args.slice(
				1,
			),
		).toEqual(["--browser", "chrome", "--executable-path", "/x"]);
	});
});
