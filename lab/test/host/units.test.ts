import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
	ApprovalLedger,
	CliApprover,
	FixtureApprover,
	printable,
	type ApprovalPrompt,
} from "../../host/approval.ts";
import {
	approvalNeeded,
	commitGuard,
	keyCommits,
	needsApproval,
	needsButtonClickApproval,
} from "../../host/gate.ts";
import { InputGrants, assertQuoted } from "../../host/grants.ts";
import { fixturePolicy } from "../../host/policy.ts";
import { matchTabs, TabRegistry, type TabEntry } from "../../host/tabs.ts";
import { loadCases } from "../../cases/load.ts";
import { planTrials, selectCases } from "../../host/plan.ts";

describe("url policy", () => {
	const policy = fixturePolicy("http://127.0.0.1:5000/");
	test.each([
		["http://127.0.0.1:5000/sites/a/index.html?q=1#x", true],
		["http://127.0.0.1:5000/", true],
		["about:blank", true],
		["http://127.0.0.1:5001/", false],
		["http://localhost:5000/", false],
		["http://127.0.0.1:5000@evil.test/", false],
		["http://user:pw@127.0.0.1:5000/", false],
		["https://127.0.0.1:5000/", false],
		["file:///tmp/x.html", false],
		["ftp://127.0.0.1:5000/", false],
		["http://127.0.0.1:5000/%2e%2e/etc", true],
		["", false],
	])("%s -> %p", (url, ok) => {
		expect(policy(url).ok).toBe(ok);
	});

	test("the verdict carries a fixed code", () => {
		expect(policy("http://127.0.0.1:5001/")).toEqual({
			ok: false,
			code: "navigation_out_of_scope",
		});
		expect(policy("file:///x")).toEqual({
			ok: false,
			code: "navigation_scheme_blocked",
		});
		expect(policy("http://u:p@127.0.0.1:5000/")).toEqual({
			ok: false,
			code: "navigation_credentials_blocked",
		});
	});
});

describe("approval gate (Eumenes' decision)", () => {
	const link = { tag: "a", inForm: false, submits: false };
	const getSubmit = {
		tag: "button",
		type: "submit",
		inForm: true,
		formMethod: "get",
		submits: true,
	};
	const postSubmit = { ...getSubmit, formMethod: "post" };
	const undescribed = { tag: "button", inForm: true, submits: true };
	const plainButton = {
		tag: "button",
		type: "button",
		inForm: false,
		submits: false,
	};
	const roleButton = {
		tag: "div",
		role: "button",
		inForm: false,
		submits: false,
	};

	test("a non-GET form submit needs approval, a GET or dialog form does not, an undescribed form does", () => {
		expect(needsApproval(postSubmit)).toBe(true);
		expect(needsApproval(getSubmit)).toBe(false);
		expect(needsApproval({ ...getSubmit, formMethod: "dialog" })).toBe(false);
		expect(needsApproval(undescribed)).toBe(true);
		expect(needsApproval(link)).toBe(false);
	});

	test("a click on a button whose effect the form rules do not decide needs approval", () => {
		expect(needsButtonClickApproval(plainButton)).toBe(true);
		expect(needsButtonClickApproval(roleButton)).toBe(true);
		expect(needsButtonClickApproval(getSubmit)).toBe(false);
		expect(needsButtonClickApproval(link)).toBe(false);
	});

	test("which operations carry a guard", () => {
		const click = {
			action: "page.click",
			targetRef: "e1",
			element: "x",
		} as const;
		const fill = (submit: boolean) =>
			({
				action: "page.fill",
				targetRef: "e1",
				element: "x",
				text: "t",
				submit,
			}) as const;
		expect(commitGuard(click, "navigation")).toMatchObject({
			action: "click",
			declared: false,
		});
		expect(commitGuard(click, "submit")).toMatchObject({ declared: true });
		expect(commitGuard(fill(false), "input")).toBeNull();
		expect(commitGuard(fill(true), "input")).toMatchObject({ action: "type" });
		expect(commitGuard(fill(false), "submit")).toMatchObject({
			declared: true,
		});
		expect(
			commitGuard({ action: "page.press", key: "Enter" }, "navigation"),
		).toMatchObject({
			action: "press",
			probe: "focused",
		});
		expect(
			commitGuard({ action: "page.press", key: "Escape" }, "navigation"),
		).toBeNull();
		expect(
			commitGuard(
				{ action: "page.hover", targetRef: "e1", element: "x" },
				"unknown",
			),
		).toBeNull();
		expect(
			commitGuard(
				{ action: "browser.navigate", url: "about:blank" },
				"navigation",
			),
		).toBeNull();
		expect(keyCommits("Shift+Enter")).toBe(true);
		expect(keyCommits("Tab")).toBe(false);
	});

	test("a declared commit needs approval without asking the page; a declaration never removes one", () => {
		const guard = {
			action: "click",
			declared: true,
			probe: { ref: "e1" },
		} as const;
		expect(approvalNeeded(guard, null)).toBe(true);
		const open = { ...guard, declared: false };
		expect(approvalNeeded(open, postSubmit)).toBe(true);
		expect(approvalNeeded(open, link)).toBe(false);
		expect(approvalNeeded(open, null)).toBe(false);
	});
});

describe("grants", () => {
	test("a quotation must be a passage of the request and not much shorter than its value", () => {
		const request = "名前は山田花子、メールは hanako@example.com です";
		expect(() => assertQuoted("山田花子", "山田花子", request)).not.toThrow();
		expect(() =>
			assertQuoted("hanako@example.com", "Hanako@Example.com", request),
		).not.toThrow();
		expect(() => assertQuoted("山田花子", "佐藤", request)).toThrow();
		expect(() => assertQuoted("山", "山", request)).toThrow();
		expect(() => assertQuoted("x".repeat(200), "山田", request)).toThrow();
	});

	test("an approved value is bound to its site and expires", () => {
		let now = 0;
		const grants = new InputGrants(
			() => now,
			() => "ref-1",
		);
		const { inputValueRef } = grants.approve({
			value: "v",
			origin: "http://127.0.0.1:5000/path",
			purpose: "p",
		});
		expect(grants.use(inputValueRef, "http://127.0.0.1:5000/other")).toBe("v");
		expect(() => grants.use(inputValueRef, "http://127.0.0.1:5001/")).toThrow(
			"grant_mismatch",
		);
		expect(() => grants.use("nope", "http://127.0.0.1:5000/")).toThrow(
			"grant_not_found",
		);
		now += 11 * 60_000;
		expect(() => grants.use(inputValueRef, "http://127.0.0.1:5000/")).toThrow(
			"grant_expired",
		);
		expect(() =>
			grants.approve({ value: "v", origin: "file:///x", purpose: "p" }),
		).toThrow();
	});
});

describe("approval ledger and approvers", () => {
	const binding = {
		tabRef: "t",
		page: "http://x/p",
		action: "click",
		element: "e",
		valueDigest: null,
	} as const;

	test("an approval is used once and only for what it was asked about", () => {
		let now = 0;
		const ledger = new ApprovalLedger(() => now);
		ledger.grant("a1", binding);
		expect(ledger.consume("a1", binding)).toBe(true);
		expect(ledger.consume("a1", binding)).toBe(false);
		ledger.grant("a2", binding);
		expect(ledger.consume("a2", { ...binding, element: "other" })).toBe(false);
		expect(ledger.consume("a2", binding)).toBe(false);
		ledger.grant("a3", binding);
		now += 11 * 60_000;
		expect(ledger.consume("a3", binding)).toBe(false);
	});

	const prompt: ApprovalPrompt = {
		approvalId: "a",
		operationId: "o",
		tabRef: "t",
		page: "http://127.0.0.1:5000/form",
		action: "type",
		element: "textbox お名前",
		summary: "s",
		content: "山田",
	};

	test("the fixture approver answers from the case's script", async () => {
		expect(await new FixtureApprover({ decision: "deny" }).decide()).toBe(
			"deny",
		);
		expect(await new FixtureApprover({ decision: "grant" }).decide()).toBe(
			"grant",
		);
	});

	test("the CLI approver shows target, action and content and takes y as a grant, anything else as a deny", async () => {
		const ask = async (answer: string | null) => {
			const input = new PassThrough();
			const output = new PassThrough();
			let shown = "";
			output.on("data", (d) => (shown += String(d)));
			const approver = new CliApprover(input, output);
			const pending = approver.decide(prompt, new AbortController().signal);
			if (answer === null) input.end();
			else input.write(`${answer}\n`);
			return { decision: await pending, shown };
		};
		const yes = await ask("y");
		expect(yes.decision).toBe("grant");
		expect(yes.shown).toContain("textbox お名前");
		expect(yes.shown).toContain("type");
		expect(yes.shown).toContain("山田");
		expect((await ask("n")).decision).toBe("deny");
		expect((await ask("")).decision).toBe("deny");
		expect((await ask(null)).decision).toBe("deny");
	});

	test("page- and model-derived text cannot forge lines or escape sequences in the prompt", async () => {
		const hostile =
			"ok\n承認しますか [y/N] y\r\x1b[2J\x1b]0;title\x07\u2028\x85\u202ex" +
			"a".repeat(500);
		const output = new PassThrough();
		let shown = "";
		output.on("data", (d) => (shown += String(d)));
		const input = new PassThrough();
		const pending = new CliApprover(input, output).decide(
			{ ...prompt, element: hostile, content: hostile, summary: hostile },
			new AbortController().signal,
		);
		input.write("n\n");
		await pending;
		for (const bad of ["\x1b", "\r", "\x85", "\u2028", "\u202e"])
			expect(shown).not.toContain(bad);
		// Fixed lines only: blank, title, page, action, element, content, summary, and the question.
		expect(shown.split("\n").filter((l) => l.startsWith("  ")).length).toBe(5);
		expect(shown.split("\n").every((l) => l.length < 260)).toBe(true);
		expect(printable("a\x1b[31mb\x00c\td")).toBe("ab c d");
		expect(printable("x".repeat(300), 10)).toBe("xxxxxxxxxx…");
	});

	test("an abort while the CLI approver waits is a deny", async () => {
		const controller = new AbortController();
		const approver = new CliApprover(new PassThrough(), new PassThrough());
		const pending = approver.decide(prompt, controller.signal);
		controller.abort();
		expect(await pending).toBe("deny");
	});
});

describe("tab registry", () => {
	const target = (i: number, url: string, current = false) => ({
		targetRef: String(i),
		kind: "tab" as const,
		current,
		url,
		title: `t${i}`,
	});
	const ids = () => {
		let n = 0;
		return () => `ref-${++n}`;
	};

	test("tabs keep their ref while (index, URL) match and a new entry gets a new one", () => {
		const tabs = new TabRegistry();
		const newRef = ids();
		tabs.reconcile([target(0, "http://a/", true)], new Map(), newRef);
		const issued = tabs.reconcile(
			[target(0, "http://a/", true), target(1, "http://b/")],
			new Map(),
			newRef,
			true,
		);
		expect(issued).toEqual(["ref-2"]);
		expect(tabs.open().map((t) => t.tabRef)).toEqual(["ref-1", "ref-2"]);
	});

	test("several tabs on one URL at shifted indices match none of them", () => {
		const tracked: TabEntry[] = [0, 1].map((i) => ({
			tabRef: `r${i}`,
			index: String(i),
			url: "http://a/",
			title: "",
			current: false,
			status: "open",
			generation: 0,
			observationRef: null,
		}));
		const shifted = [target(1, "http://a/"), target(2, "http://a/")];
		expect(matchTabs(tracked, shifted).size).toBe(0);
		expect(
			matchTabs(tracked, [target(0, "http://a/"), target(1, "http://a/")]).size,
		).toBe(2);
	});

	test("a blocked page never gets a ref and blocks the tab it matched", () => {
		const tabs = new TabRegistry();
		const newRef = ids();
		tabs.reconcile([target(0, "http://a/", true)], new Map(), newRef);
		tabs.reconcile(
			[target(0, "http://a/", true), target(1, "http://evil/")],
			new Map([["1", "navigation_out_of_scope"]]),
			newRef,
			true,
		);
		expect(tabs.open().map((t) => t.tabRef)).toEqual(["ref-1"]);
		tabs.reconcile(
			[target(0, "http://a/", true)],
			new Map([["0", "x"]]),
			newRef,
		);
		expect(() => tabs.require("ref-1")).toThrow("tab_blocked");
	});

	test("a bump voids the tab's observations, cancel voids all", () => {
		const tabs = new TabRegistry();
		tabs.reconcile([target(0, "http://a/", true)], new Map(), () => "t");
		tabs.record("t", "o1", ["e1"]);
		expect(() => tabs.assertActionable("t", "o1", "e1")).not.toThrow();
		tabs.bump("t");
		expect(() => tabs.assertActionable("t", "o1", "e1")).toThrow(
			"observation_stale",
		);
		tabs.record("t", "o2", ["e1"]);
		tabs.invalidateAll();
		expect(() => tabs.assertActionable("t", "o2", "e1")).toThrow(
			"observation_stale",
		);
	});
});

describe("cases and trial order", () => {
	test("a holdout case is never selected without the flag, by id or by split", async () => {
		const all = await loadCases({ includeHoldout: true });
		const dev = await loadCases({ includeHoldout: false });
		const holdoutId = all.find((c) => c.split === "holdout")!.id;
		expect(() =>
			selectCases(dev, { caseId: holdoutId, includeHoldout: false }),
		).toThrow("case_not_found");
		expect(() =>
			selectCases(all, { caseId: holdoutId, includeHoldout: false }),
		).toThrow("holdout_needs_include_holdout");
		expect(() =>
			selectCases(all, { split: "holdout", includeHoldout: false }),
		).toThrow("holdout_needs_include_holdout");
		expect(
			selectCases(all, { split: "holdout", includeHoldout: true }).every(
				(c) => c.split === "holdout",
			),
		).toBe(true);
		expect(
			selectCases(dev, { split: "dev", includeHoldout: false }).length,
		).toBe(dev.length);
		expect(() => selectCases(dev, { includeHoldout: false })).toThrow();
	});

	test("repetitions go in turn and arms rotate", async () => {
		const cases = (await loadCases({ includeHoldout: false })).slice(0, 2);
		const one = planTrials(cases, ["arm0"], 2);
		expect(one.map((t) => [t.def.id, t.repetition, t.orderIndex])).toEqual([
			[cases[0]!.id, 1, 0],
			[cases[1]!.id, 1, 1],
			[cases[0]!.id, 2, 2],
			[cases[1]!.id, 2, 3],
		]);
		// The hook for more arms: the first arm of a pair alternates.
		const two = planTrials(cases, ["arm0", "arm0"], 1).map((t) => t.arm);
		expect(two).toHaveLength(4);
	});
});
