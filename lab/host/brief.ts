import { completeBrief, type Brief } from "eumenes-collaboration";

/** Common-sense values for a browser task when the request does not say (shown to the model as 推定). */
const DEFAULTS = {
	who: "利用者本人",
	what: "依頼の文面どおり",
	when: "今（実行時点）",
	where: "開始ページのサイト",
	why: "依頼の文面どおり（目的の記載なし）",
	how: "部品を一つずつ使う。開けるURLはホストの方針で決まり（他のサイトへ移ることもある）、拒否されたURLは開かない。送信・購入などは承認で止まる",
} as const;

function pageUrl(reference: unknown): string | undefined {
	const page = (reference as { page?: { url?: unknown } } | null)?.page;
	return typeof page?.url === "string" ? page.url : undefined;
}

/**
 * The 5W1H of one browser request (v3 decision 4, M5). `what` is the request, `where` the start page; the
 * rest is explicitly marked as inferred. Meaning, identity and missing information stay with the model;
 * this function only packages supplied data and labeled defaults.
 */
export function browseBrief(
	request: string,
	reference: unknown,
	sourceRef = "request",
): Brief {
	const where = pageUrl(reference);
	return completeBrief({
		sourceRef,
		given: { what: request, ...(where ? { where } : {}) },
		defaults: DEFAULTS,
		mustAsk: [],
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
