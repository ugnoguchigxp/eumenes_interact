import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkArmInference, parseArm, parseCaptureDir } from "../../cli/arm.ts";
import { parseOperateFlags } from "../../cli/operate-command.ts";
import {
	claudeSettings,
	parseMaxTokens,
	startClaude,
} from "../../host/claude.ts";
import { silentLabLogger } from "../../host/log.ts";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interact-armcli-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MAIN = join(import.meta.dir, "../../cli/main.ts");
/** Runs the CLI against a database of the test's own; every case here is refused before anything starts. */
const cli = (...args: string[]) => {
	const done = Bun.spawnSync(
		["bun", MAIN, ...args, "--db", join(dir, "cli.sqlite")],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return {
		code: done.exitCode,
		err: done.stderr.toString(),
		out: done.stdout.toString(),
	};
};

describe("--arm", () => {
	test("arm1 only (Arm 0 was removed), with the command's default", () => {
		expect(parseArm(undefined, "arm1")).toBe("arm1");
		expect(parseArm("arm1", "arm1")).toBe("arm1");
		expect(() => parseArm("arm0", "arm1")).toThrow("invalid_arm");
		expect(() => parseArm("arm2", "arm1")).toThrow("invalid_arm");
	});

	test("Arm 1 and LARM do not go together", () => {
		expect(() => checkArmInference("arm1", "larm")).toThrow(
			"arm1_needs_structured_output",
		);
		expect(() => checkArmInference("arm1", "claude")).not.toThrow();
		expect(() => checkArmInference("arm1", "scripted")).not.toThrow();
	});
});

describe("--max-tokens", () => {
	test("an integer from 256 to 64000, kept with the Claude settings", () => {
		expect(parseMaxTokens(undefined)).toBeUndefined();
		expect(parseMaxTokens("4000")).toBe(4000);
		expect(parseMaxTokens(256)).toBe(256);
		for (const bad of ["255", "64001", "1.5", "x", "-1", ""])
			expect(() => parseMaxTokens(bad)).toThrow("invalid_max_tokens");
		expect(claudeSettings({ maxTokens: "4000" })).toEqual({
			model: "claude-haiku-5-5",
			effort: "low",
			maxTokens: 4000,
		});
		expect(claudeSettings({})).not.toHaveProperty("maxTokens");
	});
});

describe("what a Claude run records about itself", () => {
	test("the output bound is part of the inference info when the run set one", () => {
		const saved = process.env.ANTHROPIC_API_KEY;
		const savedOpenAI = process.env.OPENAI_API_KEY;
		// Building the client makes no call; a placeholder key is all it asks for.
		process.env.ANTHROPIC_API_KEY = "placeholder-not-a-key";
		process.env.OPENAI_API_KEY = "placeholder-not-a-key";
		try {
			const bounded = startClaude(
				claudeSettings({ maxTokens: 4000 }),
				silentLabLogger,
				"run",
			);
			expect(bounded.info()).toEqual({
				kind: "claude",
				completionReview: "dual",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				effort: "low",
				maxTokens: 4000,
			});
			const plain = startClaude(claudeSettings({}), silentLabLogger, "run");
			expect(plain.info()).not.toHaveProperty("maxTokens");
		} finally {
			if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = saved;
			if (savedOpenAI === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = savedOpenAI;
		}
	});
});

describe("--capture-dir", () => {
	test("an existing absolute directory, resolved; nothing given is nothing", () => {
		expect(parseCaptureDir(undefined)).toBeUndefined();
		expect(parseCaptureDir(dir)).toBeTruthy();
		expect(() => parseCaptureDir("relative")).toThrow(
			"capture_dir_not_absolute",
		);
		expect(() => parseCaptureDir(join(dir, "none"))).toThrow(
			"capture_dir_missing",
		);
		writeFileSync(join(dir, "f"), "x");
		expect(() => parseCaptureDir(join(dir, "f"))).toThrow(
			"capture_dir_not_directory",
		);
	});
});

describe("operate's flags", () => {
	const ok = {
		request: "x",
		"start-url": "https://ja.wikipedia.org/",
		"allow-origin": ["https://ja.wikipedia.org"],
	};

	test("Arm 1 is the default, and arm, max tokens and capture directory reach the options", () => {
		expect(parseOperateFlags(ok)).not.toHaveProperty("captureDir");
		expect(parseOperateFlags(ok).arm).toBe("arm1");
		expect(
			parseOperateFlags({
				...ok,
				arm: "arm1",
				"max-tokens": "5000",
				"capture-dir": dir,
			}),
		).toMatchObject({ arm: "arm1", maxTokens: 5000, captureDir: dir });
	});

	test("a bad arm, token bound or directory is found before anything starts", () => {
		const bad = (over: object) => () => parseOperateFlags({ ...ok, ...over });
		expect(bad({ arm: "arm9" })).toThrow("invalid_arm");
		expect(bad({ arm: "arm0" })).toThrow("invalid_arm");
		expect(bad({ "max-tokens": "10" })).toThrow("invalid_max_tokens");
		expect(bad({ "capture-dir": "rel" })).toThrow("capture_dir_not_absolute");
		expect(
			bad({ inference: "larm", "max-tokens": "5000", arm: "arm0" }),
		).toThrow("model_and_effort_are_for_claude");
	});
});

describe("the CLI", () => {
	test("run refuses a bad --arm, --max-tokens or --capture-dir, and --max-tokens without Claude", () => {
		const run = ["run", "--case", "dev-search-base"];
		expect(cli(...run, "--arm", "arm9").err).toContain("invalid_arm");
		expect(cli(...run, "--arm", "arm1", "--inference", "larm").err).toContain(
			"arm1_needs_structured_output",
		);
		expect(cli(...run, "--max-tokens", "5000").err).toContain(
			"model_and_effort_are_for_claude",
		);
		expect(cli(...run, "--capture-dir", "rel").err).toContain(
			"capture_dir_not_absolute",
		);
		expect(cli(...run, "--capture-dir", join(dir, "none")).err).toContain(
			"capture_dir_missing",
		);
	});

	test("compare and task run refuse them the same way", () => {
		expect(
			cli("compare", "--split", "dev", "--definitions", "none", "--arm", "arm9")
				.err,
		).toContain("invalid_arm");
		expect(
			cli(
				"compare",
				"--split",
				"dev",
				"--definitions",
				"none",
				"--capture-dir",
				"rel",
			).err,
		).toContain("capture_dir_not_absolute");
		expect(
			cli("task", "run", "biggo-product", "--capture-dir", "rel").err,
		).toContain("capture_dir_not_absolute");
	});

	test("operate refuses them before a lock or a browser", () => {
		const base = [
			"operate",
			"--request",
			"x",
			"--start-url",
			"https://a.example/",
			"--allow-origin",
			"https://a.example",
		];
		expect(cli(...base, "--arm", "arm9").err).toContain("invalid_arm");
		expect(cli(...base, "--capture-dir", "rel").err).toContain(
			"capture_dir_not_absolute",
		);
		expect(cli(...base, "--max-tokens", "9").err).toContain(
			"invalid_max_tokens",
		);
	});
});
