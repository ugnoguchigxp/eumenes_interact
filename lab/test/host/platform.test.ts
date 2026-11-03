import { describe, expect, test } from "bun:test";
import { parsePlatforms } from "../../cli/compare-command.ts";
import { playwrightLaunch } from "../../cli/launch.ts";
import { DEFAULT_PLATFORM, parsePlatform } from "../../cli/platform.ts";

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
	test("playwright-mcp is the default and the only one; Agent Browser is named as not adopted", () => {
		expect(DEFAULT_PLATFORM).toBe("playwright-mcp");
		expect(parsePlatform(undefined)).toBe("playwright-mcp");
		expect(parsePlatform("playwright-mcp")).toBe("playwright-mcp");
		expect(() => parsePlatform("agent-browser")).toThrow(
			"platform_not_adopted:agent-browser",
		);
		expect(() => parsePlatform("agent-desktop")).toThrow("invalid_platform");
		expect(() => parsePlatform("chrome")).toThrow("invalid_platform");
	});

	test("--platforms is a list of distinct valid platforms; one is plain repeated measurement", () => {
		expect(parsePlatforms("playwright-mcp")).toEqual(["playwright-mcp"]);
		expect(() => parsePlatforms("playwright-mcp,playwright-mcp")).toThrow(
			"platforms_must_be_distinct",
		);
		expect(() => parsePlatforms("playwright-mcp,agent-browser")).toThrow(
			"platform_not_adopted:agent-browser",
		);
	});

	test("the CLI refuses an unknown platform before it starts anything", () => {
		for (const command of [
			["task", "run", "wikipedia-article"],
			["run", "--case", "dev-search-base"],
		]) {
			const r = cli(...command, "--platform", "agent-browser");
			expect(r.code).toBe(1);
			expect(r.err).toContain("platform_not_adopted:agent-browser");
		}
		expect(
			cli("task", "run", "wikipedia-article", "--platform", "nope").err,
		).toContain("invalid_platform");
		const compare = cli("compare", "--platforms", "agent-browser");
		expect(compare.err).toContain("platform_not_adopted:agent-browser");
	});

	test("compare without --include-live refuses the definitions and does not need --platforms", () => {
		const noLive = cli("compare");
		expect(noLive.code).toBe(1);
		expect(noLive.err).toContain("live_needs_include_live");
		expect(
			cli("compare", "--platforms", "playwright-mcp", "--split", "holdout").err,
		).toContain("compare_split_must_be_dev");
	});
});

describe("the launch", () => {
	test("Playwright MCP: this runtime and the package's cli.js, with the browser options it owns, no npx", () => {
		const plain = playwrightLaunch({});
		expect(plain.command).toBe(process.execPath);
		expect(plain.args).toHaveLength(1);
		expect(plain.args[0]).toMatch(/@playwright\/mcp\/cli\.js$/);
		expect(JSON.stringify(plain)).not.toContain("npx");
		expect(
			playwrightLaunch({ channel: "chrome", executablePath: "/x" }).args.slice(
				1,
			),
		).toEqual(["--browser", "chrome", "--executable-path", "/x"]);
	});
});
