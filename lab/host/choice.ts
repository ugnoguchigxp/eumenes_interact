import { writeFileSync } from "node:fs";
import { printable } from "./approval.ts";

/**
 * The text choice channel (review 2026-11-05, owner: "the user picks options like Yahoo transit's; there is no
 * UI, so design one"). A step that cannot pick between options from the request ends with `ask` and numbered
 * lines; the chain host turns that into:
 *
 *   stdout  `choice\t{"step":…,"question":…,"options":[…],"timeoutS":…}`  (one JSON line, for a program)
 *   stdout  `choice\t  1) …` per option and `choice\t番号か選択肢の言葉で答えてください（0 で中止）`  (for a person)
 *   file    `<run dir>/choice-<step>.json`  (the same JSON, for a host that watches files)
 *
 * The reply is the next stdin line (the chain's own input, the fifo in manual mode): a number, the option's
 * words (exact, or a unique part), or `0`/`中止`. Policy: there is no default. An unclear reply is asked again
 * (3 tries); a timeout (LAB_CHOICE_TIMEOUT_S, 600 s) or end of input stops the step as `needs_input`
 * (`choice_timeout` / `choice_unanswered`), so a choice is never made silently for the user.
 */

export type Choices = { question: string; options: string[] };

const OPTION = /^\s*(?:[-*・]\s*)?[(（]?(\d{1,2})[)）.．:：、]\s*(.+?)\s*$/u;
export const MAX_OPTIONS = 9;

/** Numbered lines 1..n (n ≥ 2) in order; the other lines are the question. Null when it is a plain question. */
export function parseChoices(text: string): Choices | null {
	const question: string[] = [];
	const options: string[] = [];
	for (const line of text.split(/\r?\n/u)) {
		const m = OPTION.exec(line);
		if (m && Number(m[1]) === options.length + 1)
			options.push(printable(m[2]!, 120));
		else if (line.trim()) question.push(line.trim());
	}
	if (options.length < 2 || options.length > MAX_OPTIONS) return null;
	return {
		question: printable(question.join(" "), 400) || "どれにしますか？",
		options,
	};
}

export type Reply =
	{ kind: "chosen"; index: number } | { kind: "cancel" } | { kind: "unclear" };

const norm = (s: string) =>
	s.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");

export function matchReply(reply: string, options: readonly string[]): Reply {
	const r = norm(reply);
	if (!r) return { kind: "unclear" };
	if (r === "0" || r === "中止" || r === "キャンセル" || r === "cancel")
		return { kind: "cancel" };
	if (/^\d+$/u.test(r)) {
		const n = Number(r);
		return n >= 1 && n <= options.length
			? { kind: "chosen", index: n - 1 }
			: { kind: "unclear" };
	}
	const exact = options.findIndex((o) => norm(o) === r);
	if (exact >= 0) return { kind: "chosen", index: exact };
	// A unique start wins over a unique part: "新幹線" picks "新幹線を使う", not also "在来線のみ（新幹線なし）".
	const starts = options.flatMap((o, i) => (norm(o).startsWith(r) ? [i] : []));
	if (starts.length === 1) return { kind: "chosen", index: starts[0]! };
	const partial = options.flatMap((o, i) => (norm(o).includes(r) ? [i] : []));
	return partial.length === 1
		? { kind: "chosen", index: partial[0]! }
		: { kind: "unclear" };
}

export type Asked =
	| { kind: "chosen"; index: number; option: string }
	| {
			kind: "stopped";
			code: "choice_cancelled" | "choice_timeout" | "choice_unanswered";
	  };

export const choiceTimeoutMs = (): number => {
	const s = Number(process.env.LAB_CHOICE_TIMEOUT_S);
	return Number.isFinite(s) && s > 0 ? s * 1000 : 600_000;
};

/** Asks on stdout (and the file), reads replies with `nextLine`. */
export async function askChoice(input: {
	step: string;
	choices: Choices;
	nextLine: () => Promise<string | null>;
	print: (line: string) => void;
	file?: string;
	timeoutMs?: number;
}): Promise<Asked> {
	const timeoutMs = input.timeoutMs ?? choiceTimeoutMs();
	const { question, options } = input.choices;
	const payload = {
		step: input.step,
		question,
		options,
		timeoutS: Math.round(timeoutMs / 1000),
	};
	if (input.file) writeFileSync(input.file, `${JSON.stringify(payload)}\n`);
	input.print(`choice\t${JSON.stringify(payload)}`);
	input.print(`choice\t${question}`);
	options.forEach((o, i) => input.print(`choice\t  ${i + 1}) ${o}`));
	input.print("choice\t番号か選択肢の言葉で答えてください（0 で中止）");
	const deadline = Date.now() + timeoutMs;
	for (let tries = 0; tries < 3; tries++) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((r) => {
			timer = setTimeout(
				() => r("timeout"),
				Math.max(0, deadline - Date.now()),
			);
		});
		const line = await Promise.race([input.nextLine(), timedOut]);
		clearTimeout(timer);
		if (line === "timeout") return { kind: "stopped", code: "choice_timeout" };
		if (line === null) return { kind: "stopped", code: "choice_unanswered" };
		const reply = matchReply(line, options);
		if (reply.kind === "cancel")
			return { kind: "stopped", code: "choice_cancelled" };
		if (reply.kind === "chosen") {
			input.print(
				`choice\tselected\t${reply.index + 1}\t${options[reply.index]}`,
			);
			return {
				kind: "chosen",
				index: reply.index,
				option: options[reply.index]!,
			};
		}
		input.print(`choice\tunclear\t1〜${options.length} の番号で答えてください`);
	}
	return { kind: "stopped", code: "choice_unanswered" };
}

/** The line added to the step's request when it runs again with the user's pick. */
export function chosenLine(choices: Choices, option: string): string {
	return `（ユーザーの選択: 質問「${choices.question}」に「${option}」と答えました。この選択に従ってこのステップを続けてください。）`;
}

/** The step guidance: options the request does not decide are asked, numbered, instead of picked. */
export const CHOICE_GUIDANCE =
	"（依頼から一つに決められない選択肢（経路の種類、並び順、フォームの既定値など）があれば自分で選ばず、reply で質問と「1) …」「2) …」の番号付きの行で尋ねてください。）";
