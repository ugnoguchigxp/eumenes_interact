import { completeBrief, type Brief } from "eumenes-collaboration";

/** Common-sense values for a browser task when the request does not say (shown to the model as 推定). */
const DEFAULTS = {
	who: "利用者本人",
	what: "依頼の文面どおり",
	when: "今（実行時点）",
	where: "開始ページのサイト",
	why: "依頼の文面どおり（目的の記載なし）",
	how: "許可されたサイト内で部品を一つずつ使う。送信・購入などは承認で止まる",
} as const;

/** Words that mark a time in the request (the request then states `when`). */
const TIME =
	/今日|明日|昨日|今週|来週|先週|今月|来月|\d+\s*(年|月|日|時|分)|\d{4}-\d{2}-\d{2}/;
/** Personal data or payment: who the data belongs to must not be guessed. */
const PERSONAL =
	/氏名|名前|住所|電話|メールアドレス|生年月日|カード|口座|パスワード|支払|決済|購入|注文/;

/** A name the request gives for the person (`名前は山田花子`): then `who` is stated, not asked. */
const NAMED = /(?:お名前|名前|氏名)(?:は|：|:)\s*([^、，,。\s]+)/;

function pageUrl(reference: unknown): string | undefined {
	const page = (reference as { page?: { url?: unknown } } | null)?.page;
	return typeof page?.url === "string" ? page.url : undefined;
}

/**
 * The 5W1H of one browser request (v3 decision 4, M5). `what` is the request, `where` the start page; the
 * rest is inferred unless the request states it. Only personal data or payment without a named owner is
 * a question. Deterministic, no model call.
 */
export function browseBrief(
	request: string,
	reference: unknown,
	sourceRef = "request",
): Brief {
	const where = pageUrl(reference);
	const when = request.match(TIME)?.[0];
	const who = request.match(NAMED)?.[1];
	return completeBrief({
		sourceRef,
		given: {
			what: request,
			...(where ? { where } : {}),
			...(when ? { when } : {}),
			...(who ? { who } : {}),
		},
		defaults: DEFAULTS,
		mustAsk:
			PERSONAL.test(request) && !who
				? [
						{
							slot: "who",
							reason: "個人情報や支払いに関わるため、誰の情報かを推測しない",
						},
					]
				: [],
	});
}

/** The brief as the model reads it: data, one line per slot, inferred values marked 推定. */
export function briefMessage(brief: Brief): string {
	const lines = brief.facts.map((f) => {
		const v = f.value as {
			slot: string;
			value?: string;
			reason?: string;
		};
		if (f.kind === "condition") return `${v.slot}: ${v.value}`;
		if (f.kind === "question") return `${v.slot}: 不明（要確認: ${v.reason}）`;
		return `${v.slot}: ${v.value}（推定）`;
	});
	return `BRIEF=${JSON.stringify(lines)}`;
}
