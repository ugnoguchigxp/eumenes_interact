import { describe, expect, test } from "bun:test";
import { decideSession } from "eumenes-collaboration";
import { collabToPart, partToCollab } from "../../host/collab.ts";

describe("collab ⇄ part", () => {
	test("invoke part", () => {
		expect(
			JSON.parse(
				collabToPart(
					JSON.stringify({
						action: "invoke",
						tool: "click",
						arguments: { name: "x" },
					}),
				),
			),
		).toEqual({ part: "click", args: { name: "x" } });
	});
	test("done completes the operation", () => {
		expect(
			JSON.parse(
				collabToPart(
					JSON.stringify({
						action: "invoke",
						tool: "done",
						arguments: { evidence: ["e"] },
						text: "ok",
					}),
				),
			),
		).toEqual({ part: "done", args: { answer: "ok", evidence: ["e"] } });
	});
	test("reply means awaiting the user", () => {
		expect(
			JSON.parse(
				collabToPart(JSON.stringify({ action: "reply", text: "どれ?" })),
			),
		).toEqual({ part: "ask", args: { question: "どれ?" } });
	});
	test("discard and garbage pass through", () => {
		const d = JSON.stringify({ action: "discard" });
		expect(collabToPart(d)).toBe(d);
		expect(collabToPart("nope")).toBe("nope");
	});
	test("round trip", () => {
		for (const p of [
			{ part: "open", args: { url: "u" } },
			{ part: "ask", args: { question: "q" } },
			{ part: "done", args: { answer: "a", evidence: [] } },
		])
			expect(JSON.parse(collabToPart(partToCollab(JSON.stringify(p))))).toEqual(
				p,
			);
	});
});

describe("session stays open until the user ends it", () => {
	test("explicit completion closes", () => {
		expect(decideSession("完了", false).decision).toBe("close");
	});
	test("thanks only continues", () => {
		expect(decideSession("ありがとうございます", false).decision).toBe(
			"continue",
		);
	});
	test("new request after completion reopens", () => {
		expect(decideSession("次は請求書をダウンロードして", true).decision).toBe(
			"reopen",
		);
	});
});
