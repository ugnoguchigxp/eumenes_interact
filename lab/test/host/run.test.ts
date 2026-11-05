import { describe, expect, test } from "bun:test";
import { AdapterError } from "eumenes-interact";
import { listOperations } from "eumenes-interact/sqlite";
import { getRun } from "eumenes-interact/sqlite";
import { FixtureApprover } from "../../host/approval.ts";
import { RunControl } from "../../host/control.ts";
import { LAB_OWNER } from "../../host/run.ts";
import { listTrials } from "../../host/store.ts";
import { scoreTrial } from "../../scorer/score.ts";
import { BASE, FakeBrowser } from "./fake-adapter.ts";
import { runScripted } from "./harness.ts";

const types = (events: { type: string }[]) => events.map((e) => e.type);

test("the persisted run identifies the actual inference skill body", async () => {
	const { createArm1ScriptedInference, loadArm1Script } =
		await import("../../scripted/arm1.ts");
	const skill = { ref: "skill:test@2", digest: "sha256:test-body-v2" };
	const inference = {
		...createArm1ScriptedInference(await loadArm1Script("dev-search-base")),
		skill,
	};
	const { db, result } = await runScripted("dev-search-base", { inference });
	expect(getRun(db, LAB_OWNER, result.runId)?.skill).toEqual(skill);
	db.close();
});

describe("scripted run of a fake search flow", () => {
	test("finishes, is scored a success from the end state, and is stored", async () => {
		const { db, def, adapter, result } = await runScripted("dev-search-base");
		expect(result.status).toBe("completed");
		expect(result.score.success).toBe(true);
		expect(result.score.failures).toEqual([]);
		// Scoring the stored transcript again gives the same verdict.
		expect(scoreTrial(def, result.transcript).success).toBe(true);
		expect(adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
			"page.fill",
		]);
		const [row] = listTrials(db, { experimentId: "exp-1" });
		expect(row?.state).toBe("finished");
		expect(row?.runStatus).toBe("completed");
		expect(row?.transcript?.fixtureBaseUrl).toBe(BASE);
		expect(row?.score?.success).toBe(true);
		expect(row?.versions.tool).toEqual({
			name: "fake-playwright",
			version: "0.0.0",
		});
		expect(adapter.closeCount).toBe(1);
	});

	test("the ledger and the transcript agree, with dispatched written before the result", async () => {
		const { db, result } = await runScripted("dev-search-base");
		const ops = listOperations(db, LAB_OWNER, result.runId);
		expect(ops.map((o) => [o.action, o.status])).toEqual([
			["page.fill", "confirmed"],
		]);
		// The typed text is never stored, only its length.
		expect(JSON.stringify(ops[0]?.command)).not.toContain("白波");
		const order = types(result.transcript.events);
		expect(order.indexOf("operation.dispatched")).toBeLessThan(
			order.indexOf("operation.result"),
		);
		expect(order.at(-1)).toBe("step.final");
		const run = getRun(db, LAB_OWNER, result.runId);
		expect(run?.status).toBe("completed");
		expect(run?.coreStateRevision).toBeGreaterThan(0);
	});

	test("a clarify ends the run as needs_input and is recorded with its text", async () => {
		const { result } = await runScripted("dev-clarify-form");
		expect(result.status).toBe("needs_input");
		expect(result.score.success).toBe(true);
		const final = result.transcript.events.at(-1);
		expect(final).toMatchObject({ type: "step.final", kind: "clarify" });
	});

	test("tabs: a click that opens a tab, then tabs and tab_select, ends on the new page", async () => {
		const { result, adapter } = await runScripted("dev-tab-base");
		expect(result.status).toBe("completed");
		expect(result.score.success).toBe(true);
		const observed = result.transcript.events.flatMap((e) =>
			e.type === "observation" ? [e.url] : [],
		);
		expect(observed.at(-1)).toBe(`${BASE}sites/hoshikuzu/base/guide.html`);
		expect(adapter.closeCount).toBe(1);
	});
});

describe("a form with a commit", () => {
	test("typed quotations, selects and an approved submit reach the page and score a success", async () => {
		const { adapter, result } = await runScripted("dev-form-base");
		expect(result.status).toBe("completed");
		expect(result.score.failures).toEqual([]);
		expect(result.score.success).toBe(true);
		expect(result.score.contract.effectBeforeApproval).toBe(0);
		expect(result.score.burden.approvalRequests).toBe(1);
		expect(adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
			"page.fill",
			"page.fill",
			"page.select",
			"page.select",
			"page.click",
		]);
		const order = types(result.transcript.events);
		expect(order.indexOf("approval.answered")).toBeLessThan(
			order.lastIndexOf("operation.dispatched"),
		);
	});

	test("a deny on the submit leaves the form unsent", async () => {
		const { adapter, result } = await runScripted("dev-form-base", {
			approver: new FixtureApprover({ decision: "deny" }),
		});
		expect(result.status).toBe("needs_input");
		expect(adapter.url).toContain("apply.html");
		expect(result.score.contract.effectBeforeApproval).toBe(0);
		expect(result.score.success).toBe(false);
	});
});

describe("approval", () => {
	test("a deny from the fixture user means nothing is sent for that operation", async () => {
		const { db, adapter, result } = await runScripted("dev-approval-deny");
		expect(result.status).toBe("needs_input");
		expect(result.code).toBe("approval_denied");
		// Only the navigation link click reached the page.
		expect(
			adapter.dispatched.filter((c) => c.action === "page.click"),
		).toHaveLength(1);
		const events = result.transcript.events;
		const requested = events.find((e) => e.type === "approval.requested");
		const answered = events.find((e) => e.type === "approval.answered");
		expect(requested).toBeDefined();
		expect(answered).toMatchObject({ decision: "deny" });
		const unsent = events.filter(
			(e) => e.type === "operation.requested" && e.requiresApproval,
		);
		expect(unsent).toHaveLength(1);
		expect(
			events.filter((e) => e.type === "operation.dispatched"),
		).toHaveLength(1);
		expect(result.score.success).toBe(true);
		expect(result.score.contract.effectBeforeApproval).toBe(0);
		const ops = listOperations(db, LAB_OWNER, result.runId);
		expect(ops.at(-1)).toMatchObject({
			status: "failed",
			resultCode: "approval_denied",
			dispatchedAt: null,
		});
		const [row] = listTrials(db);
		expect(row?.runStatus).toBe("needs_input");
	});

	test("a grant sends the operation once and the approval was asked before it", async () => {
		const { adapter, result } = await runScripted("dev-approval-deny", {
			approver: new FixtureApprover({ decision: "grant" }),
		});
		expect(
			adapter.dispatched.filter((c) => c.action === "page.click"),
		).toHaveLength(2);
		expect(result.score.contract.effectBeforeApproval).toBe(0);
		const order = types(result.transcript.events);
		expect(order.indexOf("approval.answered")).toBeLessThan(
			order.lastIndexOf("operation.dispatched"),
		);
		// The case expects a refusal, so the landed effect is a failure, but never an unapproved one.
		expect(result.score.failures).toEqual(["effect_landed"]);
	});
});

describe("cancel", () => {
	test("a cancel during a send stops everything after it and the late result is not adopted", async () => {
		const control = new RunControl();
		const adapter = new FakeBrowser();
		let sends = 0;
		adapter.onDispatch = (command) => {
			if (command.action !== "page.click") return undefined;
			sends++;
			// The user cancels while the command is out; the result still comes back.
			control.cancel("cancel");
			return {
				status: "confirmed",
				retryable: false,
				url: `${BASE}sites/minato-hall/base/mail.html`,
			};
		};
		const { db, result } = await runScripted("dev-approval-deny", {
			adapter,
			control,
		});
		expect(result.status).toBe("cancelled");
		expect(sends).toBe(1);
		expect(
			adapter.dispatched.filter((c) => c.action === "page.click"),
		).toHaveLength(1);
		const events = result.transcript.events;
		const cancelAt = events.findIndex((e) => e.type === "run.cancelled");
		const late = events.find((e) => e.type === "operation.result");
		expect(cancelAt).toBeGreaterThanOrEqual(0);
		expect(late).toMatchObject({ adopted: false });
		expect(result.score.contract.sendAfterCancel).toBe(0);
		expect(result.score.contract.resultAdoptedAfterCancel).toBe(0);
		// No second model call after the cancel.
		expect(events.filter((e) => e.type === "model.call")).toHaveLength(1);
		expect(getRun(db, LAB_OWNER, result.runId)?.status).toBe("cancelled");
		// The operation's fact is still settled.
		expect(listOperations(db, LAB_OWNER, result.runId)[0]?.status).toBe(
			"confirmed",
		);
		expect(adapter.closeCount).toBe(1);
	});

	test("a deadline that has already passed expires the run before any model call", async () => {
		const { result, db } = await runScripted("dev-search-base", {
			deadlineMs: 1,
		});
		expect(result.status).toBe("expired");
		expect(getRun(db, LAB_OWNER, result.runId)?.status).toBe("expired");
		expect(result.transcript.events.some((e) => e.type === "model.call")).toBe(
			false,
		);
		expect(
			result.transcript.events.some((e) => e.type === "run.cancelled"),
		).toBe(true);
	});
});

describe("cancel and deadline at the edges", () => {
	for (const reason of ["cancel", "deadline"] as const) {
		test(`${reason} interrupts an unresolved finish gate and agrees with the stored run and trial`, async () => {
			const control = new RunControl();
			const { db, result } = await runScripted("dev-search-base", {
				control,
				beforeFinish: async (signal) => {
					queueMicrotask(() => control.cancel(reason));
					await new Promise<void>(() => {});
					signal.throwIfAborted();
					return { ok: true };
				},
			});
			const status = reason === "cancel" ? "cancelled" : "expired";
			expect(result.status).toBe(status);
			expect(getRun(db, LAB_OWNER, result.runId)?.status).toBe(status);
			expect(listTrials(db)[0]?.runStatus).toBe(status);
			expect(
				result.transcript.events.some((e) => e.type === "step.final"),
			).toBe(false);
		});
	}

	test("cancel during cleanup revokes a pending completion before it is published", async () => {
		const control = new RunControl();
		const adapter = new FakeBrowser();
		adapter.close = async () => {
			control.cancel();
		};
		const { db, result } = await runScripted("dev-search-base", {
			control,
			adapter,
		});
		expect(result.status).toBe("cancelled");
		expect(getRun(db, LAB_OWNER, result.runId)?.status).toBe("cancelled");
		expect(listTrials(db)[0]?.runStatus).toBe("cancelled");
		expect(result.transcript.events.some((e) => e.type === "step.final")).toBe(
			false,
		);
	});

	test("a cancel while the adapter opens ends the run as cancelled everywhere, with no failed final", async () => {
		const control = new RunControl();
		const adapter = new FakeBrowser();
		adapter.onOpen = () => {
			control.cancel("cancel");
			return new AdapterError("aborted", false);
		};
		const { db, result } = await runScripted("dev-search-base", {
			adapter,
			control,
		});
		expect(result.status).toBe("cancelled");
		expect(getRun(db, LAB_OWNER, result.runId)?.status).toBe("cancelled");
		expect(listTrials(db)[0]?.runStatus).toBe("cancelled");
		const events = result.transcript.events;
		expect(events.some((e) => e.type === "run.cancelled")).toBe(true);
		expect(events.some((e) => e.type === "step.final")).toBe(false);
		expect(adapter.closeCount).toBe(1);
	});

	test("a failing open without a cancel is still a failed run", async () => {
		const adapter = new FakeBrowser();
		adapter.onOpen = () => new AdapterError("mcp_unavailable", false);
		const { result } = await runScripted("dev-search-base", { adapter });
		expect(result.status).toBe("failed");
	});

	test("an inference error that arrives at the deadline is an expiry, not a failure", async () => {
		let clock = Date.now();
		const { db, result } = await runScripted("dev-search-base", {
			now: () => clock,
			deadlineMs: 60_000,
			inference: {
				complete: () => {
					// The call timeout and the run deadline fire together.
					clock += 60_000;
					return Promise.resolve({
						kind: "error",
						code: "timeout",
						usage: { inputTokens: null, outputTokens: null },
						latencyMs: 60_000,
					});
				},
			},
		});
		expect(result.status).toBe("expired");
		expect(getRun(db, LAB_OWNER, result.runId)?.status).toBe("expired");
		expect(
			result.transcript.events.some((e) => e.type === "run.cancelled"),
		).toBe(true);
		expect(result.transcript.events.some((e) => e.type === "step.final")).toBe(
			false,
		);
	});

	test("an inference error before the deadline is still a failure", async () => {
		const { result } = await runScripted("dev-search-base", {
			inference: {
				complete: () =>
					Promise.resolve({
						kind: "error",
						code: "http_500",
						usage: { inputTokens: null, outputTokens: null },
						latencyMs: 1,
					}),
			},
		});
		expect(result.status).toBe("failed");
		expect(result.code).toBe("inference_error");
	});
});

describe("an operation with an unknown outcome", () => {
	test("a click ends the run as indeterminate and sends nothing more", async () => {
		const adapter = new FakeBrowser();
		adapter.onDispatch = (command) =>
			command.action === "page.click"
				? { status: "indeterminate", code: "transport_lost", retryable: false }
				: undefined;
		const { db, result } = await runScripted("dev-tab-base", { adapter });
		expect(result.status).toBe("indeterminate");
		const actions = adapter.dispatched.map((c) => c.action);
		expect(actions.at(-1)).toBe("page.click");
		expect(actions.filter((a) => a === "page.click")).toHaveLength(1);
		const ops = listOperations(db, LAB_OWNER, result.runId);
		expect(ops.at(-1)).toMatchObject({
			status: "indeterminate",
			retryable: false,
		});
		expect(result.score.contract.resendIndeterminate).toBe(0);
		expect(result.score.success).toBe(false);
	});

	test("a host-checked search whose outcome is unknown is settled as failed and the run goes on (2026-11-04)", async () => {
		const adapter = new FakeBrowser();
		let first = true;
		adapter.onDispatch = (command) => {
			if (command.action === "page.fill" && first) {
				first = false;
				return { status: "indeterminate", code: "mcp_error", retryable: false };
			}
			return undefined;
		};
		const { db, result } = await runScripted("dev-search-base", { adapter });
		expect(result.status).not.toBe("indeterminate");
		const fill = listOperations(db, LAB_OWNER, result.runId).find(
			(o) => o.resultCode === "unconfirmed_mcp_error",
		);
		expect(fill).toMatchObject({ status: "failed" });
	});
});

describe("failures", () => {
	test("the adapter is closed even when the run breaks with an unexpected error", async () => {
		const adapter = new FakeBrowser();
		adapter.observeError = new Error("boom");
		await expect(runScripted("dev-search-base", { adapter })).rejects.toThrow(
			"boom",
		);
		expect(adapter.closeCount).toBe(1);
	});

	test("an unexpected error still leaves a finished trial and a failed run", async () => {
		const adapter = new FakeBrowser();
		adapter.observeError = new Error("boom");
		const db = (await import("./harness.ts")).freshDb();
		await runScripted("dev-search-base", { adapter, db }).catch(
			() => undefined,
		);
		const [row] = listTrials(db);
		expect(row?.state).toBe("finished");
		expect(row?.runStatus).toBe("failed");
		expect(getRun(db, LAB_OWNER, row!.runId)?.statusReason).toBe("host_error");
	});

	test("a failing open is a failed run, not an exception, and the adapter is closed", async () => {
		const adapter = new FakeBrowser();
		adapter.failOpen = true;
		const { result } = await runScripted("dev-search-base", { adapter });
		expect(result.status).toBe("failed");
		expect(result.code).toBe("mcp_unavailable");
		expect(adapter.closeCount).toBe(1);
	});

	test("an inference that breaks is a failed run with the call recorded", async () => {
		const { result } = await runScripted("dev-search-base", {
			inference: {
				complete: () =>
					Promise.resolve({
						kind: "empty",
						code: "empty",
						usage: { inputTokens: null, outputTokens: null },
						latencyMs: 1,
					}),
			},
		});
		expect(result.status).toBe("failed");
		expect(result.code).toBe("inference_empty");
		expect(result.score.outputFaults.inferenceEmpty).toBe(1);
	});
});
