import { describe, expect, test } from "bun:test";
import { askChoice, matchReply, parseChoices } from "../../host/choice.ts";

const transit =
	"どちらの経路にしますか？\n1) 在来線（安い）\n2) 新幹線（速い）";

describe("text choice channel", () => {
	test("numbered lines become options; a plain question does not", () => {
		expect(parseChoices(transit)).toEqual({
			question: "どちらの経路にしますか？",
			options: ["在来線（安い）", "新幹線（速い）"],
		});
		expect(parseChoices("何駅から出発しますか？")).toBeNull();
		expect(parseChoices("1) だけ")).toBeNull();
		expect(parseChoices("Q\n1) a\n3) c")).toBeNull();
	});
	test("only explicit numbers, complete option labels and the cancel command select an action", () => {
		const o = ["在来線（安い）", "新幹線（速い）"];
		expect(matchReply("1", o)).toEqual({ kind: "chosen", index: 0 });
		expect(matchReply("２", o)).toEqual({ kind: "chosen", index: 1 });
		expect(matchReply("新幹線（速い）", o)).toEqual({
			kind: "chosen",
			index: 1,
		});
		expect(matchReply("新幹線", o)).toEqual({ kind: "unclear" });
		expect(matchReply("線", o)).toEqual({ kind: "unclear" });
		expect(
			matchReply("新幹線", ["新幹線を使う", "在来線のみ（新幹線なし）"]),
		).toEqual({ kind: "unclear" });
		expect(matchReply("3", o)).toEqual({ kind: "unclear" });
		expect(matchReply("0", o)).toEqual({ kind: "cancel" });
		expect(matchReply("中止", o)).toEqual({ kind: "unclear" });
	});
	test("asks again on an unclear reply, then picks", async () => {
		const replies = ["?", "新幹線（速い）"];
		const out: string[] = [];
		const r = await askChoice({
			step: "s1",
			choices: parseChoices(transit)!,
			nextLine: async () => replies.shift() ?? null,
			print: (l) => out.push(l),
		});
		expect(r).toEqual({ kind: "chosen", index: 1, option: "新幹線（速い）" });
		expect(JSON.parse(out[0]!.slice("choice\t".length)).options).toHaveLength(
			2,
		);
	});
	test("no default: timeout and end of input stop the step", async () => {
		const choices = parseChoices(transit)!;
		const never = () => new Promise<string | null>(() => {});
		expect(
			await askChoice({
				step: "s1",
				choices,
				nextLine: never,
				print: () => {},
				timeoutMs: 20,
			}),
		).toEqual({
			kind: "stopped",
			code: "choice_timeout",
		});
		expect(
			await askChoice({
				step: "s1",
				choices,
				nextLine: async () => null,
				print: () => {},
			}),
		).toEqual({
			kind: "stopped",
			code: "choice_unanswered",
		});
	});
});
