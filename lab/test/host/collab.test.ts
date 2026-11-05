import { describe, expect, test } from "bun:test";
import { collaborationSchema } from "../../host/collab.ts";

test("the provider wire contract has closed objects, all required keys and explicit optional nulls", () => {
	const check = (v: unknown) => {
		if (Array.isArray(v)) {
			v.forEach(check);
			return;
		}
		if (!v || typeof v !== "object") return;
		const o = v as Record<string, unknown>;
		if (o.type === "object") {
			expect(o.additionalProperties).toBe(false);
			expect((o.required as string[]).slice().sort()).toEqual(
				Object.keys(o.properties as object).sort(),
			);
		}
		Object.values(o).forEach(check);
	};
	check(collaborationSchema());
	expect(
		JSON.parse(
			collabToPart(
				'{"action":"reply","text":"どれですか","tool":null,"arguments":null}',
			),
		),
	).toEqual({ part: "ask", args: { question: "どれですか" } });
});
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
						arguments: {
							evidence: ["e"],
							outcome: "achieved",
							basis: "observed",
						},
						text: "ok",
					}),
				),
			),
		).toEqual({
			part: "done",
			args: {
				answer: "ok",
				evidence: ["e"],
				outcome: "achieved",
				basis: "observed",
			},
		});
	});
	test("reply means awaiting the user", () => {
		expect(
			JSON.parse(
				collabToPart(JSON.stringify({ action: "reply", text: "どれ?" })),
			),
		).toEqual({ part: "ask", args: { question: "どれ?" } });
	});
	test("missing completion evidence stays missing for the core validator", () => {
		const out = JSON.parse(
			collabToPart(
				JSON.stringify({
					action: "invoke",
					tool: "done",
					arguments: { outcome: "achieved", basis: "response" },
					text: "ok",
				}),
			),
		);
		expect(Object.hasOwn(out.args, "evidence")).toBe(false);
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
			{
				part: "done",
				args: {
					answer: "a",
					evidence: [],
					outcome: "achieved",
					basis: "response",
				},
			},
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

describe("browse skill", () => {
	test("digest matches and the skill replaces the system message", async () => {
		const { loadBrowseSkill, collabAgentPort } =
			await import("../../host/collab.ts");
		const skill = await loadBrowseSkill();
		expect(skill.startsWith("あなたはブラウザ作業の担当です")).toBe(true);
		let seen = "";
		const port = collabAgentPort(
			{
				complete: async (r) => {
					seen = String(r.messages[0]!.content);
					return {
						kind: "text",
						text: JSON.stringify({ action: "reply", text: "q" }),
					} as never;
				},
			},
			skill,
		);
		await port.complete({
			messages: [
				{ role: "system", content: "OLD" },
				{ role: "user", content: "u" },
			],
		} as never);
		expect(seen.startsWith(skill + "\n")).toBe(true);
		expect(seen).toContain("TOOLS_SCHEMA=");
		expect(seen).not.toContain("OLD");
		expect(port.skill).toEqual({
			ref: "skill:browse@2",
			digest: `sha256:${new Bun.CryptoHasher("sha256").update(skill).digest("hex")}`,
		});
	});
});
