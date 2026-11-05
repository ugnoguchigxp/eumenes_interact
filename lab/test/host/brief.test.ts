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

	test("request meaning remains verbatim for the model, with no lexical time or identity classifications", () => {
		for (const request of [
			"明日の天気を調べて",
			"住所を入力して注文して",
			"私の名前を入力して",
			"名前は山田花子",
			"unknown という型を説明して",
		]) {
			const b = browseBrief(request, ref);
			expect(b.questions).toEqual([]);
			expect(b.inferred).toContain("who");
			expect(b.inferred).toContain("when");
			expect(briefMessage(b)).toContain(request);
		}
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
