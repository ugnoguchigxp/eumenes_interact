import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceOutcome, InferencePort } from "eumenes-interact";
import { ensureClaudeCredential } from "../../host/claude.ts";
import { openLabDb } from "../../host/db.ts";
import { RunnerActiveError } from "../../host/lock.ts";
import { silentLabLogger } from "../../host/log.ts";
import {
	startOperate,
	validateOperate,
	type OperateDeps,
	type OperateOptions,
} from "../../host/operate.ts";
import type { InferenceInfo } from "../../host/types.ts";
import { createScriptedInference } from "../../scripted/inference.ts";
import { FakeBrowser } from "./fake-adapter.ts";

const CLAUDE: InferenceInfo = {
	kind: "claude",
	provider: "anthropic",
	model: "claude-haiku-5-5",
	effort: "low",
};
const USAGE = {
	inputTokens: 1000,
	outputTokens: 50,
	cacheReadInputTokens: 400,
	cacheCreationInputTokens: 0,
};
const text = (t: string): InferenceOutcome => ({
	kind: "text",
	text: t,
	usage: USAGE,
	latencyMs: 5,
});
const observe = JSON.stringify({
	action: "invoke",
	tool: "browser.page.observe",
	arguments: {},
});
const finish = JSON.stringify({ action: "finish", text: "開きました。" });

/** A model that answers the first call at once and holds the second until released or cancelled. */
function gatedModel() {
	let release = () => {};
	const gate = new Promise<void>((r) => (release = r));
	let reached = () => {};
	const blocked = new Promise<void>((r) => (reached = r));
	let calls = 0;
	const port: InferencePort = {
		async complete({ signal }) {
			calls++;
			if (calls === 1) return text(observe);
			reached();
			const aborted = new Promise<"aborted">((r) =>
				signal.addEventListener("abort", () => r("aborted"), { once: true }),
			);
			const won = await Promise.race([gate.then(() => "go" as const), aborted]);
			if (won === "aborted")
				return {
					kind: "error",
					code: "aborted",
					usage: { inputTokens: null, outputTokens: null },
					latencyMs: 1,
				};
			return text(finish);
		},
	};
	return { port, release, blocked };
}

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interact-operate-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const options = (over: Partial<OperateOptions> = {}): OperateOptions => ({
	request: "Wikipediaのトップを開いてください。",
	startUrl: "https://ja.wikipedia.org/",
	allowedOrigins: ["https://ja.wikipedia.org"],
	inference: "claude",
	approver: "stop",
	dbPath: join(dir, "interact.sqlite"),
	...over,
});

const deps = (
	port: InferencePort,
	over: Partial<OperateDeps> = {},
): OperateDeps => ({
	createSession: async () => ({
		adapter: new FakeBrowser(),
		dispose: async () => {},
	}),
	inference: () => ({ port, info: () => CLAUDE, dispose: async () => {} }),
	logger: silentLabLogger,
	commit: null,
	observationsDir: join(dir, "observations"),
	...over,
});

describe("startOperate", () => {
	test("the run's id is known at once; the snapshot follows the run; done is the final snapshot", async () => {
		const model = gatedModel();
		const handle = startOperate(options(), deps(model.port));
		expect(handle.runId).toMatch(/^[0-9a-f-]{36}$/);
		// Before the run exists, there is nothing to report but that it is starting.
		expect(handle.snapshot()).toMatchObject({
			runId: handle.runId,
			status: "starting",
			modelCalls: 0,
			operations: 0,
		});
		await model.blocked;
		const mid = handle.snapshot();
		expect(mid.status).toBe("running");
		expect(mid.modelCalls).toBe(1);
		expect(mid.tokens).toEqual({
			input: 1000,
			output: 50,
			cacheRead: 400,
			cacheWrite: 0,
		});
		expect(mid.costUsdEstimate).toBeGreaterThan(0);
		expect(mid.finalUrl).toBe("https://ja.wikipedia.org/");
		expect(mid.final).toBeUndefined();
		expect(mid.finishedAt).toBeUndefined();
		model.release();
		const last = await handle.done;
		expect(last).toMatchObject({
			runId: handle.runId,
			status: "completed",
			final: { kind: "finish", text: "開きました。" },
			modelCalls: 2,
			operations: 0,
			tokens: { input: 2000, output: 100, cacheRead: 800, cacheWrite: 0 },
			inference: CLAUDE,
		});
		expect(last.finishedAt).toBeDefined();
		expect(last.costUsdEstimate).toBeCloseTo(mid.costUsdEstimate! * 2, 12);
		expect(handle.snapshot()).toEqual(last);
	});

	test("the run and its transcript are stored, unscored, with the model frozen; the request text is not", async () => {
		const model = gatedModel();
		const o = options();
		const handle = startOperate(o, deps(model.port));
		await model.blocked;
		model.release();
		const last = await handle.done;
		const db = openLabDb(o.dbPath!);
		try {
			const trial = db.query("SELECT * FROM lab_trials").get() as Record<
				string,
				string | null
			>;
			expect(trial.case_id).toBe(`operate-${handle.runId}`);
			expect(trial.split).toBe("live");
			expect(trial.state).toBe("finished");
			expect(trial.run_status).toBe("completed");
			expect(trial.score_json).toBeNull();
			expect(JSON.parse(trial.inference_json!)).toEqual(CLAUDE);
			expect(JSON.parse(trial.transcript_json!).fixtureBaseUrl).toBe(
				"https://ja.wikipedia.org/",
			);
			expect(
				db
					.query("SELECT inference_kind, includes_live FROM lab_experiments")
					.get(),
			).toEqual({
				inference_kind: "claude",
				includes_live: 1,
			});
			expect(
				db
					.query(
						"SELECT status, core_state_json FROM interact_runs WHERE run_id = ?",
					)
					.get(handle.runId),
			).toEqual({
				status: "completed",
				core_state_json: null,
			});
			const dump = JSON.stringify(
				db
					.query("SELECT * FROM lab_trials")
					.all()
					.concat(db.query("SELECT * FROM lab_experiments").all()),
			);
			expect(dump).not.toContain("Wikipediaのトップを開いてください");
			expect(last.status).toBe("completed");
		} finally {
			db.close();
		}
	});

	test("cancel stops the run: nothing more is asked, the run is cancelled, done still resolves", async () => {
		const model = gatedModel();
		const handle = startOperate(options(), deps(model.port));
		await model.blocked;
		handle.cancel();
		const last = await handle.done;
		expect(last.status).toBe("cancelled");
		expect(last.final).toBeUndefined();
		expect(last.modelCalls).toBe(2);
	});

	test("one runner at a time: a second start is refused while the first holds the lock, and may start after", async () => {
		const model = gatedModel();
		const o = options();
		const first = startOperate(o, deps(model.port));
		expect(() => startOperate(o, deps(gatedModel().port))).toThrow(
			RunnerActiveError,
		);
		await model.blocked;
		first.cancel();
		await first.done;
		expect(existsSync(`${o.dbPath}.run.lock`)).toBe(false);
		const second = gatedModel();
		const again = startOperate(o, deps(second.port));
		await second.blocked;
		again.cancel();
		expect((await again.done).status).toBe("cancelled");
	});

	test("a dispose that throws leaks neither the lock nor the database, and the run still ends as it did", async () => {
		const o = options();
		const throwing = (what: string) => async () => {
			throw new Error(`${what} failed`);
		};
		for (const failing of ["inference", "session", "both"] as const) {
			const model = gatedModel();
			const handle = startOperate(
				o,
				deps(model.port, {
					createSession: async () => ({
						adapter: new FakeBrowser(),
						dispose:
							failing === "inference" ? async () => {} : throwing("session"),
					}),
					inference: () => ({
						port: model.port,
						info: () => CLAUDE,
						dispose:
							failing === "session" ? async () => {} : throwing("inference"),
					}),
				}),
			);
			await model.blocked;
			model.release();
			const last = await handle.done;
			expect(last.status).toBe("completed");
			expect(last.final).toMatchObject({
				kind: "finish",
				text: "開きました。",
			});
			expect(existsSync(`${o.dbPath}.run.lock`)).toBe(false);
			// The database was closed: it opens again and holds the run.
			const db = openLabDb(o.dbPath);
			try {
				expect(
					db
						.query("SELECT status FROM interact_runs WHERE run_id = ?")
						.get(handle.runId),
				).toEqual({ status: "completed" });
			} finally {
				db.close();
			}
		}
	});

	test("a real site's run stores the model's final text as a length only, while its caller still gets the text", async () => {
		const model = gatedModel();
		const handle = startOperate(options(), deps(model.port));
		await model.blocked;
		model.release();
		const last = await handle.done;
		expect(last.final).toEqual({ kind: "finish", text: "開きました。" });
		const db = openLabDb(options().dbPath);
		try {
			const trial = db
				.query("SELECT transcript_json, stop_json FROM lab_trials")
				.get() as { transcript_json: string; stop_json: string };
			expect(trial.transcript_json).not.toContain("開きました");
			expect(trial.transcript_json).toContain('"textLength":6');
			expect(trial.stop_json).toBeNull();
		} finally {
			db.close();
		}
	});

	test("a missing key fails before a lock, a database or a browser is touched, naming where the key goes", () => {
		const o = options();
		let opened = false;
		let message = "";
		try {
			startOperate(o, {
				createSession: async () => {
					opened = true;
					throw new Error("no browser");
				},
				ensureCredential: () =>
					ensureClaudeCredential({}, join(dir, "absent.env")),
				logger: silentLabLogger,
				commit: null,
			});
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("claude_credential_missing");
		expect(message).toContain("ANTHROPIC_API_KEY=");
		expect(opened).toBe(false);
		expect(existsSync(o.dbPath!)).toBe(false);
		expect(existsSync(`${o.dbPath}.run.lock`)).toBe(false);
	});

	test("a bad request is refused before anything is created", () => {
		const bad = (over: Partial<OperateOptions>, code: string) => {
			expect(() =>
				startOperate(options(over), deps(gatedModel().port)),
			).toThrow(code);
			expect(existsSync(`${options().dbPath}.run.lock`)).toBe(false);
		};
		bad({ allowedOrigins: [] }, "allowed_origins_required");
		bad(
			{ allowedOrigins: ["http://ja.wikipedia.org"] },
			"invalid_allowed_origin",
		);
		bad({ startUrl: "https://example.com/" }, "start_origin_not_allowed");
		bad({ startUrl: "http://ja.wikipedia.org/" }, "invalid_start_url");
		bad({ startUrl: "https://u:p@ja.wikipedia.org/" }, "invalid_start_url");
		bad({ maxModelCalls: 13 }, "invalid_max_calls");
		bad({ maxModelCalls: 0 }, "invalid_max_calls");
		bad({ request: " " }, "invalid_request");
		bad({ effort: "extreme" as never }, "invalid_effort");
		expect(validateOperate(options({ maxModelCalls: 12 }))).toEqual({
			maxModelCalls: 12,
		});
		expect(validateOperate(options())).toEqual({ maxModelCalls: 12 });
		expect(
			validateOperate(
				options({
					startUrl: "https://tech.slashdot.org/",
					allowedOrigins: ["https://*.slashdot.org"],
				}),
			),
		).toEqual({ maxModelCalls: 12 });
	});

	test("the budget is the run's: one call allowed leaves no call for a tool and ends the run as failed", async () => {
		const model = gatedModel();
		const handle = startOperate(
			options({ maxModelCalls: 1 }),
			deps(model.port),
		);
		const last = await handle.done;
		expect(last.status).toBe("failed");
		expect(last.final).toMatchObject({
			kind: "failed",
			code: "invoke_on_last_call",
		});
		expect(last.modelCalls).toBe(1);
	});

	test("an operation that needs approval stops the run and says what it would have done; unknown tokens stay null", async () => {
		const script = {
			caseId: "x",
			steps: [
				{
					tool: "browser.page.click" as const,
					target: { role: "button", name: "メニュー" },
					args: { effect: "navigate" },
				},
			],
		};
		const handle = startOperate(
			options(),
			deps(createScriptedInference(script)),
		);
		const last = await handle.done;
		expect(last.status).toBe("needs_input");
		expect(last.final).toMatchObject({
			kind: "stopped",
			code: "approval_denied",
		});
		expect(last.approval).toMatchObject({
			action: "click",
			url: "https://ja.wikipedia.org/",
		});
		expect(last.operations).toBe(0);
		// A scripted model reports no usage: unknown, not 0, and so no cost.
		expect(last.tokens).toEqual({
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
		});
		expect(last.costUsdEstimate).toBeNull();
		// What the stop is stored as holds no text the page may have shaped: codes and sizes only.
		const db = openLabDb(options().dbPath);
		try {
			const row = db.query("SELECT stop_json FROM lab_trials").get() as {
				stop_json: string;
			};
			const stored = JSON.parse(row.stop_json) as Record<string, unknown>;
			expect(stored).toMatchObject({ code: "approval_denied" });
			expect(typeof stored.textLength).toBe("number");
			expect(typeof stored.approvals).toBe("number");
			expect(stored).not.toHaveProperty("text");
		} finally {
			db.close();
		}
	});

	test("a page outside the allowed origins is refused by the policy: the run does not leave them", async () => {
		const adapter = new FakeBrowser();
		const handle = startOperate(
			options({ allowedOrigins: ["https://ja.wikipedia.org"] }),
			deps(gatedModel().port, {
				createSession: async () => ({ adapter, dispose: async () => {} }),
			}),
		);
		handle.cancel();
		await handle.done;
		expect(
			adapter.dispatched.every(
				(c) =>
					c.action === "browser.navigate" &&
					c.url.startsWith("https://ja.wikipedia.org/"),
			),
		).toBe(true);
	});

	test("--keep-observations keeps each observation for the run, and old ones are removed at the start", async () => {
		const observationsDir = join(dir, "observations");
		mkdirSync(join(observationsDir, "stale-trial"), { recursive: true });
		writeFileSync(join(observationsDir, "stale-trial", "1.txt"), "x");
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		utimesSync(join(observationsDir, "stale-trial"), old, old);
		const model = gatedModel();
		const handle = startOperate(
			options({ keepObservations: true }),
			deps(model.port, { observationsDir }),
		);
		await model.blocked;
		model.release();
		await handle.done;
		expect(readdirSync(observationsDir)).toEqual([handle.runId]);
		expect(
			readdirSync(join(observationsDir, handle.runId)).length,
		).toBeGreaterThan(0);
	});
});
