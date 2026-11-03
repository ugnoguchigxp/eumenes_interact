import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AdapterCommand, HostCall } from "eumenes-interact";
import {
	createRun,
	listOperations,
	listUnsettledOperations,
	transitionRun,
} from "eumenes-interact/sqlite";
import {
	FixtureApprover,
	type ApprovalPrompt,
	type Approver,
} from "../../host/approval.ts";
import { RunControl } from "../../host/control.ts";
import { write } from "../../host/db.ts";
import { createExecutor, type Executed } from "../../host/executor.ts";
import { InputGrants } from "../../host/grants.ts";
import { silentLabLogger, type LabLogger } from "../../host/log.ts";
import { fixturePolicy } from "../../host/policy.ts";
import { LAB_OWNER } from "../../host/run.ts";
import { TabRegistry } from "../../host/tabs.ts";
import { TrialRecorder } from "../../host/trial.ts";
import { BASE, FakeBrowser } from "./fake-adapter.ts";
import { freshDb } from "./harness.ts";

const INDEX = `${BASE}sites/hoshikuzu/base/index.html`;

async function setup(
	options: {
		approver?: Approver;
		request?: string;
		follow?: boolean;
		logger?: LabLogger;
	} = {},
) {
	const db = freshDb();
	const adapter = new FakeBrowser();
	await adapter.open();
	const runId = randomUUID();
	const nowIso = new Date().toISOString();
	write(db, () => {
		createRun(db, LAB_OWNER, {
			runId,
			skillRef: "skill",
			skillDigest: "digest",
			catalogRef: "catalog",
			catalogDigest: "digest",
			platform: "playwright-mcp",
			coreFormatVersion: 1,
			policy: { maxModelCalls: 12, retries: { default: 1 } },
			nowIso,
		});
		transitionRun(db, LAB_OWNER, runId, "running", { nowIso });
	});
	const control = new RunControl();
	const recorder = new TrialRecorder(Date.now);
	const grants = new InputGrants(Date.now, randomUUID);
	const executor = createExecutor({
		db,
		owner: LAB_OWNER,
		runId,
		sessionId: randomUUID(),
		adapter,
		policy: fixturePolicy(BASE),
		tabs: new TabRegistry(),
		grants,
		approver: options.approver ?? new FixtureApprover({ decision: "grant" }),
		recorder,
		logger: options.logger ?? silentLabLogger,
		...(options.follow ? { followOwnNavigation: true } : {}),
		control,
		now: Date.now,
		newId: randomUUID,
		request: options.request ?? "「白波」を検索してください。",
	});
	const first = await executor.start(INDEX);
	const tabRef = first.tabs[0]!.tabRef;
	const operate = (
		command: AdapterCommand,
		observationRef: string | undefined,
		extra: Partial<Extract<HostCall, { kind: "operate" }>> = {},
	): HostCall => ({
		kind: "operate",
		tabRef,
		...(observationRef ? { observationRef } : {}),
		command,
		declaredEffect: "navigation",
		...extra,
	});
	return {
		db,
		adapter,
		runId,
		control,
		recorder,
		grants,
		executor,
		first,
		tabRef,
		operate,
	};
}

const click = (targetRef: string): AdapterCommand => ({
	action: "page.click",
	targetRef,
	element: "element",
});

const refused = (r: Executed) =>
	r.kind === "outcome" && r.outcome.kind === "refused" ? r.outcome.code : null;

describe("observations and generations", () => {
	test("an operation on an observation the page has moved past is refused before sending", async () => {
		const s = await setup();
		const old = s.first.observation.observationRef;
		const moved = await s.executor.execute(s.operate(click("e4"), old));
		expect(moved.kind === "outcome" && moved.outcome.kind).toBe("operation");
		const sent = s.adapter.dispatched.length;
		const stale = await s.executor.execute(s.operate(click("e5"), old));
		expect(refused(stale)).toBe("observation_stale");
		expect(s.adapter.dispatched.length).toBe(sent);
		expect(listOperations(s.db, LAB_OWNER, s.runId)).toHaveLength(1);
	});

	test("a ref that the latest observation does not show is not actionable", async () => {
		const s = await setup();
		const result = await s.executor.execute(
			s.operate(click("e99"), s.first.observation.observationRef),
		);
		expect(refused(result)).toBe("ref_not_actionable");
		expect(s.adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
		]);
	});

	test("an operation without an observation reference is stale", async () => {
		const s = await setup();
		expect(
			refused(await s.executor.execute(s.operate(click("e4"), undefined))),
		).toBe("observation_stale");
	});

	test("the adapter's own cut is merged into the observation", async () => {
		const s = await setup();
		expect(s.first.observation.truncated).toBe(false);
		expect(s.first.observation.generation).toBe(0);
	});
});

describe("destination policy", () => {
	test.each([
		"http://127.0.0.1:9/sites/hoshikuzu/base/index.html",
		"http://127.0.0.1.evil.test:41234/",
		"file:///etc/passwd",
		"https://127.0.0.1:41234/",
		"http://user:pw@127.0.0.1:41234/",
		"javascript:alert(1)",
		"not a url",
	])("navigating to %s is refused and nothing is sent", async (url) => {
		const s = await setup();
		const before = s.adapter.dispatched.length;
		const result = await s.executor.execute(
			s.operate({ action: "browser.navigate", url }, undefined),
		);
		expect(refused(result)).toMatch(/^navigation_/);
		expect(s.adapter.dispatched.length).toBe(before);
	});

	test("a new tab outside the scope is refused before it is opened", async () => {
		const s = await setup();
		const result = await s.executor.execute({
			kind: "tabs.new",
			url: "http://127.0.0.1:9/",
		});
		expect(refused(result)).toBe("navigation_out_of_scope");
		expect(s.adapter.calls).not.toContain("newTarget");
	});

	test("a page the action ends on outside the scope is dropped and its tab blocked", async () => {
		const s = await setup();
		s.adapter.nextTabUrl = "http://127.0.0.1:9/elsewhere";
		const result = await s.executor.execute(
			s.operate(click("e5"), s.first.observation.observationRef, {
				declaredEffect: "navigation",
			}),
		);
		expect(result.kind === "outcome" && result.outcome.kind).toBe("operation");
		if (result.kind === "outcome" && result.outcome.kind === "operation") {
			expect(result.outcome.result).toMatchObject({
				status: "failed",
				code: "navigation_out_of_scope",
			});
			expect(result.outcome.observation).toBeUndefined();
		}
		const listed = await s.executor.execute({ kind: "tabs.list" });
		if (listed.kind === "outcome" && listed.outcome.kind === "tabs")
			expect(listed.outcome.tabs.every((t) => t.url?.startsWith(BASE))).toBe(
				true,
			);
	});

	test("about:blank is allowed", async () => {
		const s = await setup();
		const result = await s.executor.execute(
			s.operate({ action: "browser.navigate", url: "about:blank" }, undefined),
		);
		expect(refused(result)).toBeNull();
	});
});

describe("unknown outcomes and cancel", () => {
	test("an indeterminate operation is never sent again", async () => {
		const s = await setup();
		s.adapter.onDispatch = (c) =>
			c.action === "page.click"
				? { status: "indeterminate", code: "transport_lost", retryable: false }
				: undefined;
		const call = s.operate(click("e4"), s.first.observation.observationRef);
		const first = await s.executor.execute(call);
		expect(first).toMatchObject({ kind: "end", status: "indeterminate" });
		const sent = s.adapter.dispatched.length;
		s.adapter.onDispatch = null;
		const again = await s.executor.execute(call);
		expect(again).toMatchObject({ kind: "end", status: "indeterminate" });
		expect(s.adapter.dispatched.length).toBe(sent);
		const unsettled = listUnsettledOperations(s.db, LAB_OWNER);
		expect(unsettled.map((o) => o.status)).toEqual(["indeterminate"]);
	});

	test("nothing is sent after a cancel", async () => {
		const s = await setup();
		s.control.cancel("cancel");
		const sent = s.adapter.dispatched.length;
		const result = await s.executor.execute(
			s.operate(click("e4"), s.first.observation.observationRef),
		);
		expect(result).toMatchObject({ kind: "end", status: "cancelled" });
		expect(s.adapter.dispatched.length).toBe(sent);
	});

	test("a run that is no longer running accepts no new intent", async () => {
		const s = await setup();
		write(s.db, () =>
			transitionRun(s.db, LAB_OWNER, s.runId, "cancelled", {
				nowIso: new Date().toISOString(),
			}),
		);
		const sent = s.adapter.dispatched.length;
		const result = await s.executor.execute(
			s.operate(click("e4"), s.first.observation.observationRef),
		);
		expect(result).toMatchObject({ kind: "end", status: "cancelled" });
		expect(s.adapter.dispatched.length).toBe(sent);
	});
});

describe("approval gate", () => {
	test("a plain button needs approval by what the element is, whatever the model declared", async () => {
		const asked: ApprovalPrompt[] = [];
		const s = await setup({
			approver: {
				decide: (prompt) => {
					asked.push(prompt);
					return Promise.resolve("deny");
				},
			},
		});
		const result = await s.executor.execute(
			s.operate(click("e6"), s.first.observation.observationRef),
		);
		expect(result).toMatchObject({
			kind: "outcome",
			outcome: { kind: "stop", code: "approval_denied" },
		});
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ action: "click", element: "element" });
		expect(s.adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
		]);
	});

	test("a link and a GET search need no approval", async () => {
		const asked: ApprovalPrompt[] = [];
		const s = await setup({
			approver: {
				decide: (prompt) => {
					asked.push(prompt);
					return Promise.resolve("grant");
				},
			},
		});
		const result = await s.executor.execute(
			s.operate(click("e4"), s.first.observation.observationRef),
		);
		expect(result.kind).toBe("outcome");
		expect(asked).toHaveLength(0);
	});

	test("an approver that fails denies", async () => {
		const s = await setup({
			approver: { decide: () => Promise.reject(new Error("no terminal")) },
		});
		const result = await s.executor.execute(
			s.operate(click("e6"), s.first.observation.observationRef),
		);
		expect(result).toMatchObject({
			outcome: { kind: "stop", code: "approval_denied" },
		});
	});
});

describe("the approval ledger", () => {
	test("is matched against the state at dispatch: an approval for one page does not send on another", async () => {
		let navigate: (() => Promise<unknown>) | null = null;
		const s = await setup({
			approver: {
				decide: async () => {
					// While the user decides, something else moves the page; a key press has no element ref
					// whose staleness would catch it, so the ledger itself must.
					await navigate?.();
					return "grant";
				},
			},
		});
		navigate = () =>
			s.executor.execute(
				s.operate(
					{
						action: "browser.navigate",
						url: `${BASE}sites/hoshikuzu/base/guide.html`,
					},
					undefined,
				),
			);
		const sent = () => s.adapter.dispatched.map((c) => c.action);
		const result = await s.executor.execute(
			s.operate({ action: "page.press", key: "Enter" }, undefined, {
				declaredEffect: "submit",
			}),
		);
		expect(refused(result)).toBe("approval_required");
		expect(sent()).not.toContain("page.press");
		expect(sent()).toContain("browser.navigate");
	});

	test("lets the operation through when nothing changed", async () => {
		const s = await setup();
		const result = await s.executor.execute(
			s.operate({ action: "page.press", key: "Enter" }, undefined, {
				declaredEffect: "submit",
			}),
		);
		expect(refused(result)).toBeNull();
		expect(s.adapter.dispatched.map((c) => c.action)).toContain("page.press");
	});
});

describe("input values", () => {
	const fill = (text: string): AdapterCommand => ({
		action: "page.fill",
		targetRef: "e8",
		element: "searchbox",
		text,
		submit: false,
	});

	test("a quotation that is not in the request is refused before it is recorded", async () => {
		const s = await setup();
		const result = await s.executor.execute(
			s.operate(fill("別の語"), s.first.observation.observationRef, {
				declaredEffect: "input",
				inputProvenance: { kind: "request_quote", quote: "別の語" },
			}),
		);
		expect(refused(result)).toBe("grant_source_mismatch");
		expect(listOperations(s.db, LAB_OWNER, s.runId)).toHaveLength(0);
	});

	test("a quotation of the request is typed", async () => {
		const s = await setup();
		await s.executor.execute(
			s.operate(fill("白波"), s.first.observation.observationRef, {
				declaredEffect: "input",
				inputProvenance: { kind: "request_quote", quote: "白波" },
			}),
		);
		expect(s.adapter.dispatched.at(-1)).toMatchObject({ text: "白波" });
	});

	test("an approved value is resolved by the host and kept out of the transcript and the ledger", async () => {
		const s = await setup();
		const { inputValueRef } = s.grants.approve({
			value: "秘密の語",
			origin: BASE,
			purpose: "検索語",
		});
		await s.executor.execute(
			s.operate(fill(""), s.first.observation.observationRef, {
				declaredEffect: "input",
				inputProvenance: { kind: "grant", inputValueRef },
			}),
		);
		expect(s.adapter.dispatched.at(-1)).toMatchObject({ text: "秘密の語" });
		const requested = s.recorder.events.find(
			(e) => e.type === "operation.requested",
		);
		expect(JSON.stringify(requested)).not.toContain("秘密の語");
		const [op] = listOperations(s.db, LAB_OWNER, s.runId);
		expect(JSON.stringify(op)).not.toContain("秘密の語");
	});

	test("a grant for another site and an unknown grant are refused", async () => {
		const s = await setup();
		const other = s.grants.approve({
			value: "x",
			origin: "http://127.0.0.1:1/",
			purpose: "p",
		});
		const call = (ref: string) =>
			s.operate(fill(""), s.first.observation.observationRef, {
				declaredEffect: "input",
				inputProvenance: { kind: "grant", inputValueRef: ref },
			});
		expect(refused(await s.executor.execute(call(other.inputValueRef)))).toBe(
			"grant_mismatch",
		);
		expect(refused(await s.executor.execute(call(randomUUID())))).toBe(
			"grant_not_found",
		);
	});
});

describe("tabs", () => {
	test("refs are stable UUIDs and a tab that moved out from under its ref is lost, not swapped", async () => {
		const s = await setup();
		expect(s.tabRef).toMatch(/^[0-9a-f-]{36}$/);
		const listed = await s.executor.execute({ kind: "tabs.list" });
		if (listed.kind !== "outcome" || listed.outcome.kind !== "tabs")
			throw new Error("tabs expected");
		expect(listed.outcome.tabs.map((t) => t.tabRef)).toEqual([s.tabRef]);
		// The page navigates behind the host's back: the pair (index, URL) no longer matches.
		s.adapter.goto(`${BASE}sites/hoshikuzu/base/guide.html`);
		const result = await s.executor.execute({
			kind: "observe",
			tabRef: s.tabRef,
		});
		expect(refused(result)).toBe("tab_lost");
	});
});

describe("a page that settles on another URL after its own action", () => {
	const SETTLED = `${BASE}sites/hoshikuzu/base/index.html?settled=1`;

	/** A confirmed click whose result URL is the old one; the page then settles somewhere else. */
	function redirecting(s: Awaited<ReturnType<typeof setup>>, to = SETTLED) {
		s.adapter.onDispatch = (c, b) => {
			if (c.action !== "page.click") return undefined;
			b.settleTo = to;
			return {
				status: "confirmed",
				retryable: false,
				url: INDEX,
				title: "星屑堂書店",
			};
		};
	}
	const click4 = (s: Awaited<ReturnType<typeof setup>>) =>
		s.executor.execute(
			s.operate(click("e4"), s.first.observation.observationRef),
		);
	const observed = (r: Executed) =>
		r.kind === "outcome" && r.outcome.kind === "operation"
			? r.outcome.observation
			: undefined;

	test("in a definition run the tab follows it: the observation after the action is of the settled page", async () => {
		const events: unknown[] = [];
		const logger: LabLogger = {
			event() {},
			lab: (name, fields) => void events.push({ name, ...fields }),
			close() {},
		};
		const s = await setup({ follow: true, logger });
		redirecting(s);
		const first = s.first.observation;
		const done = await click4(s);
		const obs = observed(done);
		expect(obs?.url).toBe(SETTLED);
		// The page is not the one observed before: a new generation, and the old observation is void.
		expect(obs!.generation).toBeGreaterThan(first.generation);
		expect(events).toContainEqual({
			name: "tab.navigation_followed",
			correlationId: s.runId,
			code: "tab_url_settled",
		});
		const again = await s.executor.execute({
			kind: "observe",
			tabRef: s.tabRef,
		});
		expect(again.kind === "outcome" && again.outcome.kind).toBe("observation");
		expect(
			refused(
				await s.executor.execute(s.operate(click("e5"), first.observationRef)),
			),
		).toBe("observation_stale");
	});

	test("in the Arm 0 path the tab is lost, as in Eumenes", async () => {
		const s = await setup();
		redirecting(s);
		const done = await click4(s);
		expect(observed(done)).toBeUndefined();
		expect(
			refused(await s.executor.execute({ kind: "observe", tabRef: s.tabRef })),
		).toBe("tab_lost");
	});

	test("only the first look after the action follows: a second change is lost again", async () => {
		const s = await setup({ follow: true });
		redirecting(s);
		await click4(s);
		s.adapter.setTabUrl(0, `${BASE}sites/hoshikuzu/base/guide.html`);
		expect(
			refused(await s.executor.execute({ kind: "observe", tabRef: s.tabRef })),
		).toBe("tab_lost");
	});

	test("a change in the number of tabs is not followed", async () => {
		const s = await setup({ follow: true });
		s.adapter.onDispatch = (c, b) => {
			if (c.action !== "page.click") return undefined;
			b.setTabUrl(0, SETTLED);
			b.openTab(`${BASE}sites/hoshikuzu/base/guide.html`);
			return { status: "confirmed", retryable: false, url: INDEX };
		};
		const done = await click4(s);
		expect(observed(done)).toBeUndefined();
		expect(
			refused(await s.executor.execute({ kind: "observe", tabRef: s.tabRef })),
		).toBe("tab_lost");
	});

	test("another tracked tab that moved is not followed either", async () => {
		const s = await setup({ follow: true });
		const opened = await s.executor.execute({
			kind: "tabs.new",
			url: `${BASE}sites/hoshikuzu/base/guide.html`,
		});
		expect(opened.kind).toBe("outcome");
		redirecting(s);
		s.adapter.onDispatch = (c, b) => {
			if (c.action !== "page.click") return undefined;
			b.settleTo = SETTLED;
			b.setTabUrl(1, `${BASE}sites/hoshikuzu/base/map.html`);
			return { status: "confirmed", retryable: false, url: INDEX };
		};
		const done = await click4(s);
		expect(observed(done)).toBeUndefined();
		expect(
			refused(await s.executor.execute({ kind: "observe", tabRef: s.tabRef })),
		).toBe("tab_lost");
	});

	test("two other tabs that both still match let the tab follow", async () => {
		const s = await setup({ follow: true });
		await s.executor.execute({
			kind: "tabs.new",
			url: `${BASE}sites/hoshikuzu/base/guide.html`,
		});
		await s.executor.execute({
			kind: "tabs.new",
			url: `${BASE}sites/hoshikuzu/base/map.html`,
		});
		redirecting(s);
		expect(observed(await click4(s))?.url).toBe(SETTLED);
	});

	test("a settled URL the policy refuses blocks the tab", async () => {
		const s = await setup({ follow: true });
		redirecting(s, "http://127.0.0.1:9/elsewhere");
		const done = await click4(s);
		expect(observed(done)).toBeUndefined();
		expect(
			refused(await s.executor.execute({ kind: "observe", tabRef: s.tabRef })),
		).toBe("tab_blocked");
		// Nothing of that page was adopted.
		const listed = await s.executor.execute({ kind: "tabs.list" });
		if (listed.kind === "outcome" && listed.outcome.kind === "tabs")
			expect(listed.outcome.tabs).toEqual([]);
	});
});
