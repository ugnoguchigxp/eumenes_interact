import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notices } from "../../cli/run-command.ts";
import { parseOperateFlags } from "../../cli/operate-command.ts";
import {
	claudeSettings,
	ensureClaudeCredential,
	parseDotenv,
	parseEffort,
	parseModel,
	REPO_ENV,
} from "../../host/claude.ts";

const MAIN = join(import.meta.dir, "../../cli/main.ts");
const cli = (...args: string[]) => {
	const done = Bun.spawnSync(["bun", MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: done.exitCode,
		err: done.stderr.toString(),
		out: done.stdout.toString(),
	};
};

describe("the Claude settings", () => {
	test("Haiku 5.5 at low effort by default, and both can be chosen", () => {
		expect(claudeSettings({})).toEqual({
			model: "claude-haiku-5-5",
			effort: "low",
		});
		expect(claudeSettings({ model: "claude-opus-5", effort: "max" })).toEqual({
			model: "claude-opus-5",
			effort: "max",
		});
		for (const effort of ["low", "medium", "high", "xhigh", "max"])
			expect(parseEffort(effort) as string).toBe(effort);
	});

	test("an unknown effort or a model that is not a model id is refused", () => {
		expect(() => parseEffort("extreme")).toThrow("invalid_effort");
		expect(() => parseEffort("")).toThrow("invalid_effort");
		expect(() => parseModel("")).toThrow("invalid_model");
		expect(() => parseModel("a b")).toThrow("invalid_model");
		expect(() => parseModel("-x")).toThrow("invalid_model");
		expect(parseModel("claude-haiku-5-5")).toBe("claude-haiku-5-5");
	});

	test("the notice says a claude run costs money and is the user's to start", () => {
		const base = {
			includeHoldout: false,
			includeLive: false,
			keepObservations: false,
			repeat: 1,
			headed: false,
		};
		const text = notices({ ...base, inference: "claude" }, false, false).join(
			"\n",
		);
		expect(text).toContain("--inference claude");
		expect(text).toContain("costs money");
		expect(text).toContain("user-triggered");
		expect(notices({ ...base, inference: "scripted" }, false, false)).toEqual(
			[],
		);
	});
});

describe("the credential", () => {
	let dir = "";
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "interact-env-test-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("a missing key fails fast and says where to put it, without a key in the message", () => {
		const env: Record<string, string | undefined> = {};
		let message = "";
		try {
			ensureClaudeCredential(env, join(dir, "absent.env"));
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("claude_credential_missing");
		expect(message).toContain("ANTHROPIC_API_KEY=");
		expect(message).toContain(join(dir, "absent.env"));
	});

	test("the environment is enough, and nothing is read from the file then", () => {
		const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "k" };
		expect(() => ensureClaudeCredential(env, "/no/such/file")).not.toThrow();
		expect(() =>
			ensureClaudeCredential({ ANTHROPIC_AUTH_TOKEN: "t" }, "/no/such/file"),
		).not.toThrow();
		// An empty value is no value.
		expect(() =>
			ensureClaudeCredential({ ANTHROPIC_API_KEY: "" }, "/no/such/file"),
		).toThrow("claude_credential_missing");
	});

	test("a .env file of the repository is read when the process started elsewhere, and the key goes only into the environment given", () => {
		const file = join(dir, ".env");
		writeFileSync(
			file,
			'# a comment\nOTHER=1\nexport ANTHROPIC_API_KEY="sk-from-file"\n',
		);
		const env: Record<string, string | undefined> = {};
		ensureClaudeCredential(env, file);
		expect(env.ANTHROPIC_API_KEY).toBe("sk-from-file");
		// A file without the key is still a missing key.
		writeFileSync(file, "OTHER=1\n");
		expect(() => ensureClaudeCredential({}, file)).toThrow(
			"claude_credential_missing",
		);
	});

	test("the dotenv lines: quotes, export, comments, blanks", () => {
		expect(
			parseDotenv("A=1\n\n# B=2\n  export C = 'x y' \nD=\"z\"\nE=\nbad line\n"),
		).toEqual({ A: "1", C: "x y", D: "z", E: "" });
	});

	test("the .env of the repository is the one at its root", () => {
		expect(REPO_ENV).toBe(join(import.meta.dir, "../../..", ".env"));
	});
});

describe("the operate flags", () => {
	const ok = {
		request: "検索して",
		"start-url": "https://www.youtube.com/",
		"allow-origin": ["https://www.youtube.com"],
	};

	test("defaults: Claude, low effort left to the host, stop approver, headless", () => {
		const o = parseOperateFlags(ok);
		expect(o).toMatchObject({
			request: "検索して",
			startUrl: "https://www.youtube.com/",
			allowedOrigins: ["https://www.youtube.com"],
			inference: "claude",
			approver: "stop",
			headed: false,
			keepObservations: false,
		});
		expect(o.maxModelCalls).toBeUndefined();
	});

	test("the flags are carried: model, effort, max calls, approver, headed, keep, db, several origins", () => {
		const o = parseOperateFlags({
			...ok,
			"allow-origin": ["https://www.youtube.com", "https://*.google.com"],
			model: "claude-haiku-5-5",
			effort: "high",
			"max-calls": "6",
			approver: "cli",
			headed: true,
			"keep-observations": true,
			db: "/tmp/x.sqlite",
		});
		expect(o).toMatchObject({
			allowedOrigins: ["https://www.youtube.com", "https://*.google.com"],
			model: "claude-haiku-5-5",
			effort: "high",
			maxModelCalls: 6,
			approver: "cli",
			headed: true,
			keepObservations: true,
			dbPath: "/tmp/x.sqlite",
		});
	});

	test("allowed origins are required, and the rest of the request is checked", () => {
		const bad = (over: object) => () =>
			parseOperateFlags({ ...ok, ...over } as never);
		expect(bad({ "allow-origin": undefined })).toThrow(
			"operate_needs_allow_origin",
		);
		expect(bad({ "allow-origin": [] })).toThrow("operate_needs_allow_origin");
		expect(bad({ request: undefined })).toThrow("operate_needs_request");
		expect(bad({ request: "  " })).toThrow("invalid_request");
		expect(bad({ "start-url": undefined })).toThrow("operate_needs_start_url");
		expect(bad({ "start-url": "http://www.youtube.com/" })).toThrow(
			"invalid_start_url",
		);
		expect(bad({ "start-url": "https://other.example/" })).toThrow(
			"start_origin_not_allowed",
		);
		expect(bad({ "allow-origin": ["http://www.youtube.com"] })).toThrow();
		expect(bad({ "allow-origin": ["https://www.youtube.com/path"] })).toThrow(
			"invalid_allowed_origin",
		);
		expect(
			bad({
				"allow-origin": ["https://*.google.com", "https://www.youtube.com"],
			}),
		).not.toThrow();
	});

	test("max calls is at most 12, an integer, at least 1", () => {
		const calls = (n: string) => () =>
			parseOperateFlags({ ...ok, "max-calls": n });
		expect(calls("12")).not.toThrow();
		expect(calls("1")).not.toThrow();
		for (const n of ["13", "0", "-1", "2.5", "x"])
			expect(calls(n)).toThrow("invalid_max_calls");
	});

	test("inference, approver and effort are checked; model and effort are for Claude", () => {
		const bad = (over: object) => () =>
			parseOperateFlags({ ...ok, ...over } as never);
		expect(bad({ inference: "scripted" })).toThrow("invalid_inference");
		expect(bad({ approver: "fixture" })).toThrow("invalid_approver");
		expect(bad({ effort: "extreme" })).toThrow("invalid_effort");
		expect(bad({ inference: "larm", model: "m" })).toThrow(
			"model_and_effort_are_for_claude",
		);
		// Arm 1 (the default of operate) needs a model that follows a schema; LARM does not yet.
		expect(bad({ inference: "larm" })).toThrow("arm1_needs_structured_output");
		expect(bad({ inference: "larm", arm: "arm0" })).toThrow("invalid_arm");
	});

	test("the CLI refuses a bad request before it starts anything", () => {
		const common = [
			"operate",
			"--request",
			"x",
			"--start-url",
			"https://a.example/",
		];
		const noOrigin = cli(...common);
		expect(noOrigin.code).toBe(1);
		expect(noOrigin.err).toContain("operate_needs_allow_origin");
		const tooMany = cli(
			...common,
			"--allow-origin",
			"https://a.example",
			"--max-calls",
			"13",
		);
		expect(tooMany.code).toBe(1);
		expect(tooMany.err).toContain("invalid_max_calls");
		expect(tooMany.out).toBe("");
		const other = cli(...common, "--allow-origin", "https://b.example");
		expect(other.err).toContain("start_origin_not_allowed");
	});
});
