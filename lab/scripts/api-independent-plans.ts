import { readFileSync, writeFileSync } from "node:fs";
import { chainPlan, toBrowser } from "../host/chain.ts";
import {
	startClaude,
	startLuna,
	ensureClaudeCredential,
	paidLedger,
} from "../host/claude.ts";
import { silentLabLogger } from "../host/log.ts";
const fixtures = JSON.parse(
	readFileSync(
		new URL("../evaluation/independent-plan-cases.json", import.meta.url),
		"utf8",
	),
) as {
	authorship: string;
	cases: {
		id: string;
		request: string;
		check: string;
		url?: string;
		urls?: string[];
	}[];
};
const rows: unknown[] = [];
ensureClaudeCredential();
for (const fixture of fixtures.cases) {
	for (const p of ["claude", "openai"] as const) {
		const session =
			p === "claude"
				? startClaude(
						{ model: "claude-haiku-5-5", effort: "low" },
						silentLabLogger,
						fixture.id,
					)
				: startLuna();
		try {
			const plan = await chainPlan(
				fixture.request,
				session.raw,
				AbortSignal.timeout(90_000),
			);
			const browser = plan.steps.filter((s) => toBrowser(s));
			let passed = false;
			if (fixture.check === "text")
				passed = plan.steps.every(
					(s) =>
						!toBrowser(s) &&
						!s.keepOpen &&
						s.completion === "response" &&
						s.start === null,
				);
			if (fixture.check === "iri")
				passed =
					browser.length > 0 &&
					new URL(browser[0]!.start!).href === new URL(fixture.url!).href &&
					browser.every((s) => s.completion === "observed");
			if (fixture.check === "compare")
				passed =
					plan.steps.length === 3 &&
					toBrowser(plan.steps[0]!) &&
					toBrowser(plan.steps[1]!) &&
					!toBrowser(plan.steps[2]!) &&
					fixture.urls!.every(
						(u, i) => new URL(plan.steps[i]!.start!).href === new URL(u).href,
					) &&
					plan.steps[2]!.inputs.includes(plan.steps[0]!.id) &&
					plan.steps[2]!.inputs.includes(plan.steps[1]!.id) &&
					plan.steps[2]!.completion === "response";
			if (fixture.check === "observed")
				passed =
					browser.length > 0 &&
					new URL(browser[0]!.start!).href === new URL(fixture.url!).href &&
					plan.steps.every(
						(s) =>
							s.start === null ||
							new URL(s.start).href === new URL(fixture.url!).href,
					) &&
					plan.steps.every((s) => s.completion !== "playback");
			rows.push({ provider: p, case: fixture.id, passed, plan });
			console.log(p, fixture.id, passed ? "pass" : "FAIL");
		} catch (e) {
			rows.push({
				provider: p,
				case: fixture.id,
				passed: false,
				error: e instanceof Error ? e.message : "unknown",
			});
			console.log(p, fixture.id, "FAIL");
		} finally {
			await session.dispose();
		}
	}
}
const ledger = paidLedger();
const report = {
	at: new Date().toISOString(),
	authorship: fixtures.authorship,
	scope:
		"Independent-authored planning cases; implementation author executed all cases. No real website visit or independent user claim.",
	rows,
	budget: ledger.summary(),
};
ledger.close();
writeFileSync(
	`docs/reviews/2026-11-05/implementation/api-independent-plans-${Date.now()}.json`,
	JSON.stringify(report, null, 2) + "\n",
);
if (rows.some((r) => !(r as { passed: boolean }).passed)) process.exitCode = 1;
