import { describe, expect, test } from "bun:test";
import { briefMessage, browseBrief } from "../../host/brief.ts";
import { collabAgentPort, loadBrowseSkill } from "../../host/collab.ts";

const ref = { connection: "c", page: { url: "https://www.youtube.com/" } };

describe("the 5W1H brief of a browser request (M5)", () => {
	test("a plain search request: what and where are given, the rest inferred, nothing asked", () => {
		const b = browseBrief("「AI research」で検索して動画を開いて", ref);
		expect(b.inferred).toEqual(["who", "when", "why", "how"]);
		expect(b.questions).toEqual([]);
		const text = briefMessage(b);
		expect(text).toContain("where: https://www.youtube.com/");
		expect(text).toContain("who: 利用者本人（推定）");
		expect(text).not.toContain("要確認");
	});

	test("a stated time is given, not inferred", () => {
		const b = browseBrief("明日の天気を調べて", ref);
		expect(b.inferred).not.toContain("when");
	});

	test("personal data or payment without an owner is the only question", () => {
		const b = browseBrief("住所を入力して注文して", ref);
		expect(b.questions).toEqual(["who"]);
		expect(briefMessage(b)).toContain("who: 不明（要確認");
	});

	test("a named person states who, so a form request with its values asks nothing", () => {
		const b = browseBrief(
			"見学を申し込んでください。名前は山田花子、メールアドレスは hanako@example.com です。",
			ref,
		);
		expect(b.questions).toEqual([]);
		expect(briefMessage(b)).toContain("who: 山田花子");
	});

	test("without a page url the start site is inferred", () => {
		expect(browseBrief("一覧を見せて", { connection: "c" }).inferred).toContain(
			"where",
		);
	});

	test("the collab agent puts the brief as data between REFERENCE and the request", async () => {
		let seen: { role: string; content: string }[] = [];
		const port = collabAgentPort(
			{
				complete: async (r) => {
					seen = r.messages as never;
					return {
						kind: "text",
						text: JSON.stringify({ action: "reply", text: "q" }),
					} as never;
				},
			},
			loadBrowseSkill(),
		);
		await port.complete({
			messages: [
				{ role: "system", content: "OLD" },
				{ role: "user", content: `REFERENCE=${JSON.stringify(ref)}` },
				{ role: "user", content: "検索して" },
			],
		} as never);
		expect(seen.map((m) => m.content.slice(0, 10))).toEqual([
			loadBrowseSkill().slice(0, 10),
			"REFERENCE=",
			'BRIEF=["wh',
			"検索して",
		]);
		expect(seen.at(-1)!.content).toBe("検索して");
	});
});
