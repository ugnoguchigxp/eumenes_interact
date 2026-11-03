import { describe, expect, test } from "bun:test";
import type { ObservationEnvelope } from "../../src/contracts/observation.ts";
import {
	parseStep,
	prepareStep,
	shapeObservation,
	startRun,
} from "../../src/core/index.ts";

/** Agent Browser prints the ref inside a bracket that may hold other attributes. */
const BODY = [
	"- banner:",
	'  - link "Wikipedia" [ref=e1, url=https://ja.wikipedia.org/wiki/Main?x=1]',
	'  - searchbox "Wikipedia内を検索" [ref=e26]',
	"- main:",
	'  - radio "小" [checked=false, ref=e322]',
	'  - link "寄付" [ref=e27, url=https://donate.wikimedia.org/?wmf_source=donate]',
	'  - button "検索" [disabled, ref=e28, expanded=false]',
	'  - heading "ref=e99 is only text" [level=2]',
].join("\n");

const shape = (body: string) =>
	shapeObservation("arm0", { body, truncated: false, missing: [] });

describe("Agent Browser snapshots", () => {
	test("refs are listed and counted wherever they sit in the attribute list", () => {
		expect(shape(BODY)).toEqual({
			body: BODY,
			truncated: false,
			truncationReasons: [],
			refCount: 5,
			refs: ["e1", "e26", "e322", "e27", "e28"],
		});
	});

	test("Playwright bodies are read as before", () => {
		const body =
			'- button "検索" [ref=e3] [cursor=pointer]\n- link "x" [active] [ref=e4]';
		expect(shape(body).refs).toEqual(["e3", "e4"]);
	});

	test("the ref charset is unchanged", () => {
		expect(
			shape('- button "x" [ref=e 1]\n- button "y" [ref=e.2]').refs,
		).toEqual([]);
		expect(shape('- button "z" [a=b, ref=A_b-9]').refs).toEqual(["A_b-9"]);
		expect(shape('- button "w" [myref=e1]').refs).toEqual([]);
	});

	test("the body is bounded by refs, bytes and depth at node boundaries", () => {
		const many = Array.from(
			{ length: 260 },
			(_, i) => `- radio "r${i}" [checked=false, ref=e${i}]`,
		).join("\n");
		expect(shape(many)).toMatchObject({
			truncated: true,
			truncationReasons: ["refs"],
			refCount: 200,
		});
		const long = Array.from(
			{ length: 400 },
			(_, i) =>
				`- link "l${i}" [ref=e${i}, url=https://example.com/${"p".repeat(200)}${i}]`,
		).join("\n");
		const cut = shape(long);
		expect(cut.truncationReasons).toEqual(["bytes"]);
		expect(cut.refs.length).toBeLessThan(200);
		expect(cut.body.split("\n")).toHaveLength(cut.refs.length);
		const deep = `${Array.from(
			{ length: 14 },
			(_, d) => `${"  ".repeat(d)}- group [ref=g${d}]:`,
		).join("\n")}\n`;
		expect(shape(deep)).toMatchObject({
			truncationReasons: ["depth"],
			refCount: 12,
		});
	});

	describe("the latest observation's refs are the actionable ones", () => {
		const TAB = "11111111-1111-4111-8111-111111111111";
		const OBS = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
		const envelope: ObservationEnvelope = {
			observationRef: OBS,
			platform: "agent-browser",
			sessionId: "s",
			target: { kind: "tab", tabRef: TAB },
			generation: 1,
			capturedAt: "2026-11-03T05:00:00.000Z",
			url: "https://ja.wikipedia.org/",
			title: "Wikipedia",
			...shape(BODY),
			truncationReasons: [],
			missing: [],
		};
		const state = () =>
			startRun({
				arm: "arm0",
				request: "寄付のリンクを開いて",
				policy: { maxModelCalls: 6, retries: { default: 1 } },
				nowMs: 0,
				reference: { observation: envelope },
			});
		const click = (ref: string) =>
			JSON.stringify({
				action: "invoke",
				tool: "browser.page.click",
				arguments: {
					observationRef: OBS,
					ref,
					element: "link",
					effect: "navigate",
				},
			});

		test("a ref in an attribute list can be clicked", () => {
			for (const ref of ["e1", "e26", "e322", "e27", "e28"])
				expect(parseStep(state(), click(ref)).step.kind).toBe("call");
		});

		test("a ref the body does not show is refused locally", () => {
			for (const ref of ["e99", "e2", "url", "ref"]) {
				const out = parseStep(state(), click(ref));
				expect(out.step).toEqual({ kind: "continue", callsLeft: 5 });
				const messages = prepareStep(out.state).messages;
				expect(
					JSON.parse(messages.at(-1)!.content.replace("TOOL_RESULT=", "")),
				).toMatchObject({
					ok: false,
					error: "ref_not_actionable",
				});
			}
		});
	});
});
