import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostOutcome, StartRunInput } from "../../src/contracts/core.ts";
import {
	ARM0_SOURCE_COMMIT,
	applyResult,
	parseStep,
	prepareStep,
	shapeObservation,
	startRun,
} from "../../src/core/index.ts";
import { boundSnapshot } from "../../src/core/arm0/observation.ts";
import * as texts from "../../src/core/arm0/texts.ts";

/**
 * The identity test of plan.md §4: for the same input the Arm 0 core produces the same SystemContext, messages
 * and fold results as Eumenes at the source commit. The golden files are written by
 * `lab/arm0-golden/generate.ts` from Eumenes' own modules.
 */
const GOLDEN = join(import.meta.dir, "../../../../lab/arm0-golden/golden");
const golden = (name: string) =>
	JSON.parse(readFileSync(join(GOLDEN, name), "utf8"));

test("the golden files come from the commit the core was ported from", () => {
	for (const name of ["texts", "system", "bound", "scenarios"])
		expect(golden(`${name}.json`).meta.commit).toBe(ARM0_SOURCE_COMMIT);
});

test("authored texts equal what Eumenes renders", () => {
	const g = golden("texts.json");
	expect(texts.PROFILE).toBe(g.profile);
	expect([texts.SKILL]).toEqual(g.skills);
	expect(texts.RULES).toBe(g.rules);
	expect(texts.REFERENCE_INTRO).toBe(g.referenceIntro);
	expect(texts.CORRECTION).toBe(g.correction);
	expect(
		g.tools.map((t: { id: string }) => [
			t.id,
			texts.TOOL_SUMMARIES[t.id as keyof typeof texts.TOOL_SUMMARIES],
		]),
	).toEqual(
		g.tools.map((t: { id: string; summary: string }) => [t.id, t.summary]),
	);
});

describe("system message", () => {
	for (const c of golden("system.json").cases)
		test(c.name, () => {
			const state = startRun({
				arm: "arm0",
				request: "検索して",
				policy: { maxModelCalls: 8, retries: { default: 1 } },
				nowMs: 0,
				tools: c.tools,
				...(c.approvedInput
					? {
							reference: {
								approved: [{ kind: "input_value", inputValueRef: "x" }],
							},
						}
					: {}),
			});
			expect(prepareStep(state).messages[0]).toEqual({
				role: "system",
				content: c.system,
			});
		});
});

describe("bounded snapshots", () => {
	for (const c of golden("bound.json").cases)
		test(c.name, () => {
			if (c.limits) {
				expect(boundSnapshot(c.body, c.limits)).toEqual(c.bounded);
				return;
			}
			expect(
				shapeObservation("arm0", {
					body: c.body,
					truncated: false,
					missing: [],
				}),
			).toEqual({
				body: c.bounded.text,
				truncated: c.bounded.truncated,
				truncationReasons: c.bounded.reasons,
				refCount: c.bounded.refs.length,
				refs: c.bounded.refs,
			});
		});
});

type Snapshot = {
	callsMade: number;
	repaired: boolean;
	refusals: Record<string, number>;
	pendingRaw: string | null;
	messages: { role: string; content: string }[];
};
const taskOf = (state: unknown): Snapshot => {
	const { callsMade, repaired, refusals, pendingRaw, messages } = (
		state as { task: Snapshot & { messages: Snapshot["messages"] } }
	).task;
	return {
		callsMade,
		repaired,
		refusals,
		pendingRaw,
		messages: messages.slice(1),
	};
};

describe("scenarios replayed against Eumenes' messages and decisions", () => {
	for (const scenario of golden("scenarios.json").scenarios)
		test(scenario.name, () => {
			let state = startRun(scenario.start.input as StartRunInput);
			expect(prepareStep(state).messages).toEqual([
				{ role: "system", content: scenario.start.systemMessage },
				...scenario.start.messages,
			]);
			for (const step of scenario.steps) {
				const want = step.expected;
				const parsed = parseStep(state, step.output);
				state = parsed.state;
				const at = `${scenario.name}: ${step.label}`;
				let got: { kind: string; [key: string]: unknown } = parsed.step;
				if (want.via === "host") {
					expect(got.kind, at).toBe("call");
					const applied = applyResult(state, step.host as HostOutcome);
					state = applied.state;
					got = applied.step;
				}
				if (want.step === "stop") {
					expect(got, at).toEqual({
						kind: "stop",
						code: want.code,
						text: want.text,
						approvals: want.approvals,
					});
				} else if (want.step === "failed") {
					expect(got, at).toMatchObject({ kind: "failed", code: want.code });
				} else if (want.step === "continue") {
					expect(got, at).toEqual({
						kind: "continue",
						callsLeft: want.callsLeft,
					});
					expect(taskOf(state), at).toEqual(want.task);
				} else {
					expect(got, at).toMatchObject(
						want.step === "finish"
							? { kind: "finish", text: want.text, refs: want.refs }
							: { kind: "clarify", text: want.text },
					);
				}
			}
		});
});
