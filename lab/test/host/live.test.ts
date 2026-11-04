import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRun, listOperations } from "eumenes-interact/sqlite";
import { loadCases } from "../../cases/load.ts";
import type { CaseDef } from "../../cases/schema.ts";
import { notices } from "../../cli/run-command.ts";
import { summaryLines } from "../../cli/report.ts";
import {
	OBSERVATION_RETENTION_MS,
	createObservationSink,
	pruneObservations,
} from "../../host/observations.ts";
import { selectCases } from "../../host/plan.ts";
import { isPrivateHost, originPolicy } from "../../host/policy.ts";
import { LAB_OWNER } from "../../host/run.ts";
import { listTrials } from "../../host/store.ts";
import { runScripted } from "./harness.ts";
import { FakeBrowser } from "./fake-adapter.ts";

const all = await loadCases({ includeHoldout: true, includeLive: true });
const def = all.find((c) => c.id === "live-youtube-ai-research") as CaseDef;
const YT = "https://www.youtube.com";

describe("the live YouTube scenario with a fake browser", () => {
	test("searches, plays a video and is scored a success from the URL", async () => {
		const { adapter, result, db } = await runScripted(def.id, { def });
		expect(result.status).toBe("completed");
		expect(result.score.failures).toEqual([]);
		expect(result.score.success).toBe(true);
		expect(result.score.contract.scopeViolations).toBe(0);
		expect(result.transcript.fixtureBaseUrl).toBe(`${YT}/`);
		expect(adapter.dispatched.map((c) => c.action)).toEqual([
			"browser.navigate",
			"page.fill",
			"page.click",
		]);
		expect(adapter.dispatched[0]).toMatchObject({ url: `${YT}/` });
		expect(adapter.dispatched[1]).toMatchObject({
			text: "AI research",
			submit: true,
		});
		// The click took the first of the video links, not the second (nth is the author's choice).
		expect(adapter.dispatched[2]).toMatchObject({ targetRef: "e2" });
		expect(adapter.url).toBe(`${YT}/watch?v=abc123`);
		const lines = summaryLines(result);
		expect(lines[0]).toContain("success");
		expect(lines[1]).toContain("finish");
		expect(lines[2]).toContain("/watch?v=abc123");
		expect(listTrials(db)[0]?.split).toBe("live");
		expect(adapter.closeCount).toBe(1);
	});

	test("without --keep-observations the pages the model read are stored nowhere", async () => {
		const { db, result } = await runScripted(def.id, { def });
		const run = getRun(db, LAB_OWNER, result.runId);
		expect(run?.coreState).toBeNull();
		expect(run?.coreStateRevision).toBe(0);
		const stored = JSON.stringify(
			db
				.query("SELECT transcript_json, score_json, stop_json FROM lab_trials")
				.all(),
		);
		expect(stored).not.toContain("のしくみ");
		// Nor the element names in the ledger.
		const ops = JSON.stringify(listOperations(db, LAB_OWNER, result.runId));
		expect(ops).not.toContain("のしくみ");
		expect(ops).toContain("(redacted)");
	});

	test("with an observation sink every body goes there and the state is saved as before", async () => {
		const dir = mkdtempSync(join(tmpdir(), "interact-obs-test-"));
		try {
			const sink = createObservationSink(dir);
			const { db, result } = await runScripted(def.id, {
				def,
				observationSink: sink,
			});
			const kept = readdirSync(join(dir, result.trialId)).sort();
			const observed = result.transcript.events.filter(
				(e) => e.type === "observation",
			).length;
			expect(kept).toEqual(
				Array.from({ length: observed }, (_, i) => `${i + 1}.txt`),
			);
			const last = readFileSync(
				join(dir, result.trialId, `${observed}.txt`),
				"utf8",
			);
			expect(last).toContain(`url: ${YT}/watch?v=abc123`);
			expect(last).toContain("title: AI research のしくみ - YouTube");
			expect(last).toContain("一時停止");
			expect(
				getRun(db, LAB_OWNER, result.runId)?.coreStateRevision,
			).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a page on another origin is a scope violation the scorer counts, and not a success", async () => {
		const adapter = new FakeBrowser();
		adapter.onDispatch = (command) =>
			command.action === "page.click"
				? {
						status: "confirmed",
						retryable: false,
						url: "https://consent.example.com/x",
					}
				: undefined;
		const { result } = await runScripted(def.id, { def, adapter });
		// The policy refuses to adopt the page, and the transcript still shows where the browser went.
		expect(result.score.contract.scopeViolations).toBe(1);
		expect(result.score.success).toBe(false);
	});
});

describe("selecting live cases", () => {
	const dev = all.filter((c) => c.split === "dev");
	test("a live case is never selected without the flag", () => {
		expect(() =>
			selectCases(dev, { caseId: def.id, includeHoldout: false }),
		).toThrow("case_not_found");
		expect(() =>
			selectCases(all, { caseId: def.id, includeHoldout: true }),
		).toThrow("live_needs_include_live");
		expect(() =>
			selectCases(all, { split: "live", includeHoldout: false }),
		).toThrow("live_needs_include_live");
		expect(
			selectCases(all, {
				caseId: def.id,
				includeHoldout: false,
				includeLive: true,
			}),
		).toEqual([def]);
		expect(
			selectCases(all, {
				split: "live",
				includeHoldout: false,
				includeLive: true,
			}),
		).toEqual([def]);
	});

	test("the notices say a live run is the user's to start, and what answers approvals", () => {
		const base = {
			includeHoldout: false,
			includeLive: true,
			keepObservations: false,
			repeat: 1,
			inference: "scripted" as const,
			headed: false,
		};
		expect(notices(base, false, true).join("\n")).toContain("user-triggered");
		expect(notices({ ...base, approver: "cli" }, false, true)).toHaveLength(1);
		const fixture = notices({ ...base, approver: "fixture" }, false, true, [
			"許可済み",
		]);
		expect(fixture).toHaveLength(2);
		expect(fixture.join("\n")).toContain("許可済み");
		expect(notices({ ...base, includeLive: false }, false, false)).toEqual([]);
	});
});

describe("the live URL policy", () => {
	const policy = originPolicy([YT]);
	test.each([
		[`${YT}/`, true],
		[`${YT}/watch?v=abc#t=1`, true],
		["about:blank", true],
		["http://www.youtube.com/", false],
		["https://youtube.com/", false],
		["https://m.youtube.com/", false],
		["https://www.youtube.com:8443/", false],
		["https://www.youtube.com.evil.test/", false],
		["https://evil.test/", false],
		["https://user:pw@www.youtube.com/", false],
		["https://www.youtube.com@evil.test/", false],
		["ftp://www.youtube.com/", false],
		["file:///etc/passwd", false],
		["javascript:alert(1)", false],
		["data:text/html,x", false],
		["", false],
	])("%s -> %p", (url, ok) => {
		expect(policy(url).ok).toBe(ok);
	});

	test.each([
		"http://localhost/",
		"https://localhost:3000/",
		"https://127.0.0.1/",
		"https://127.1/",
		"https://2130706433/",
		"https://10.0.0.5/",
		"https://172.16.0.1/",
		"https://192.168.1.1/",
		"https://169.254.169.254/",
		"https://100.64.0.1/",
		"https://[::1]/",
		"https://[fe80::1]/",
		"https://[::ffff:127.0.0.1]/",
		"https://printer.local/",
		"https://nas.internal/",
		"https://intranet/",
	])("%s is private and refused even if an origin list named it", (url) => {
		const origin = new URL(url).origin;
		const verdict = originPolicy([origin])(url);
		expect(verdict).toEqual({ ok: false, code: "navigation_private_blocked" });
	});

	test("an open-web step leaves its site without approval but keeps every other refusal", () => {
		const open = originPolicy([YT], true);
		expect(open("https://andreasfertig.com/blog/x").ok).toBe(true);
		expect(open("http://example.org/").ok).toBe(true);
		expect(open("https://192.168.1.1/")).toEqual({
			ok: false,
			code: "navigation_private_blocked",
		});
		expect(open("https://u:p@example.org/")).toEqual({
			ok: false,
			code: "navigation_credentials_blocked",
		});
		expect(open("file:///etc/passwd").ok).toBe(false);
		expect(open("javascript:alert(1)").ok).toBe(false);
		expect(originPolicy([YT])("https://andreasfertig.com/").ok).toBe(false);
	});

	test("public hosts are not private", () => {
		expect(isPrivateHost("www.youtube.com")).toBe(false);
		expect(isPrivateHost("8.8.8.8")).toBe(false);
		for (const h of ["127.0.0.1.nip.io", "app.10-0-0-1.sslip.io", "lvh.me", "x.localtest.me"])
			expect(isPrivateHost(h)).toBe(true);
		expect(isPrivateHost("notnip.io")).toBe(false);
		expect(isPrivateHost("[2606:4700::1111]")).toBe(false);
	});

	test("fixed codes", () => {
		expect(policy("https://evil.test/")).toEqual({
			ok: false,
			code: "navigation_out_of_scope",
		});
		expect(policy("ftp://www.youtube.com/")).toEqual({
			ok: false,
			code: "navigation_scheme_blocked",
		});
		expect(policy("https://u:p@www.youtube.com/")).toEqual({
			ok: false,
			code: "navigation_credentials_blocked",
		});
	});
});

describe("wildcard origins in the URL policy", () => {
	const policy = originPolicy(["https://*.slashdot.org", YT]);
	test.each([
		["https://slashdot.org/", true],
		["https://tech.slashdot.org/story/26/11/03/x", true],
		["https://a.b.slashdot.org/", true],
		["https://SLASHDOT.org/", true],
		[`${YT}/`, true],
		["https://evilslashdot.org/", false],
		["https://slashdot.org.evil.test/", false],
		["https://slashdot.org@evil.test/", false],
		["http://tech.slashdot.org/", false],
		["https://tech.slashdot.org:8443/", false],
		["https://slashdot.org:8443/", false],
		["https://tech.slashdot.org.attacker.test/", false],
		["https://u:p@tech.slashdot.org/", false],
		["https://org/", false],
		["https://[::1]/", false],
	])("%s -> %p", (url, ok) => {
		expect(policy(url).ok).toBe(ok);
	});

	test("the private and loopback refusal still applies under a wildcard", () => {
		const wide = originPolicy(["https://*.local", "https://*.internal"]);
		expect(wide("https://printer.local/")).toEqual({
			ok: false,
			code: "navigation_private_blocked",
		});
		expect(wide("https://svc.internal/")).toEqual({
			ok: false,
			code: "navigation_private_blocked",
		});
		expect(wide("https://localhost/")).toEqual({
			ok: false,
			code: "navigation_private_blocked",
		});
	});
});

describe("kept observations", () => {
	test("the sink writes <trial>/<seq>.txt readable by the owner only", () => {
		const dir = mkdtempSync(join(tmpdir(), "interact-obs-test-"));
		try {
			createObservationSink(dir)("trial-1", 1, {
				url: "https://a.test/",
				title: "T",
				body: "- main",
			});
			const file = join(dir, "trial-1", "1.txt");
			expect(readFileSync(file, "utf8")).toBe(
				"url: https://a.test/\ntitle: T\n\n- main\n",
			);
			expect(readdirSync(dir)).toEqual(["trial-1"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("trial directories older than seven days are deleted, others and non-directories are not", async () => {
		const dir = mkdtempSync(join(tmpdir(), "interact-obs-test-"));
		const outside = mkdtempSync(join(tmpdir(), "interact-obs-outside-"));
		try {
			const now = Date.now();
			const day = 24 * 60 * 60 * 1000;
			const age = (name: string, days: number) => {
				mkdirSync(join(dir, name));
				writeFileSync(join(dir, name, "1.txt"), "x");
				const at = new Date(now - days * day);
				utimesSync(join(dir, name), at, at);
			};
			age("old", 8);
			age("edge", 6.9);
			age("fresh", 1);
			writeFileSync(join(dir, "note.txt"), "keep");
			symlinkSync(outside, join(dir, "link"));
			writeFileSync(join(outside, "precious"), "keep");
			const old = new Date(now - 30 * day);
			utimesSync(outside, old, old);
			expect(OBSERVATION_RETENTION_MS).toBe(7 * day);
			expect(await pruneObservations(dir, now)).toEqual(["old"]);
			expect(readdirSync(dir).sort()).toEqual([
				"edge",
				"fresh",
				"link",
				"note.txt",
			]);
			expect(existsSync(join(outside, "precious"))).toBe(true);
			expect(await pruneObservations(join(dir, "missing"), now)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("the CLI listing", () => {
	test("live cases appear only with --include-live", () => {
		const main = join(import.meta.dir, "../../cli/main.ts");
		const list = (...args: string[]) =>
			Bun.spawnSync(["bun", main, "cases", ...args], {
				stdout: "pipe",
				stderr: "pipe",
			}).stdout.toString();
		expect(list()).not.toContain("live-youtube-ai-research");
		expect(list("--include-holdout")).not.toContain("live-youtube-ai-research");
		expect(list("--include-live")).toContain("live-youtube-ai-research");
	});
});
