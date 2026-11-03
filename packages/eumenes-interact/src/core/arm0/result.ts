import type { z } from "zod";
import type { ObservationEnvelope } from "../../contracts/observation.ts";
import type { TabView } from "../../contracts/core.ts";
import type { TaskToolResult } from "./task.ts";
import { clip, placeOf } from "./text.ts";

/**
 * What the model reads of a tool's outcome: the refusal codes with their hints and the views of observations
 * and tabs. Ported from Eumenes `api/application/browser/browser-task-tools.ts` (commit 98b188d2); only the
 * hints of codes the ported tools can produce are kept.
 */

/** What a model can do about a refusal; the code alone is not always enough. */
const HINTS: Record<string, string> = {
	observation_stale:
		"ページが変わりました。結果の最新のobservationを使うか、observeで観測し直してください。",
	ref_not_actionable:
		"その要素は最新の観測にありません。observationRefとrefを最新の観測から取り直してください。",
	approval_required: "利用者の確認が要る操作です。",
	tab_blocked:
		"そのタブは開けないページを表示しているため操作できません。別のタブを選ぶか、利用者に伝えてください。",
	navigation_unresolved_blocked:
		"ホスト名を確認できないため開けません。別のURLを試すか、利用者に伝えてください。",
	grant_mismatch:
		"入力先のサイトか用途が、値を作ったときと違います。入力先のページで改めて入力してください。",
	grant_not_found:
		"その入力許可番号は存在しません。原文の語句を入力する場合はinputValueRefを省き、valueと原文中のquoteを両方指定してください。原文にない値には利用者の許可が必要です。",
	tab_lost: "そのタブは見つかりません。tabsで一覧を取り直してください。",
	tab_busy: "そのタブは別の作業が使っています。",
	no_target_tab:
		"操作するタブがありません。tabsで一覧を見て、tab_selectで選んでください。",
	effect_required: "submitがtrueのときはeffectを宣言してください。",
	value_source:
		"inputValueRefかvariableを使うならvalueとquoteは書かず（二つは同時に使えません）、どちらも使わないならvalueとquoteを書いてください。",
	script_variable_unknown:
		"その名前の変数は今回のScriptに宣言されていません。browser.page.scriptのvariablesに名前・説明・今回の値を宣言してから使ってください。",
	navigation_scheme_blocked: "httpとhttps以外は開けません。",
	navigation_private_blocked: "ローカルや社内のアドレスは開けません。",
	navigation_api_blocked: "EumenesのAPIのアドレスは開けません。",
	navigation_credentials_blocked: "認証情報を含むURLは開けません。",
	navigation_invalid_url: "URLの形が正しくありません。",
};

/** Only authored contract hints may be returned; validator messages can otherwise contain input data. */
export const argumentHints = (issues: readonly z.core.$ZodIssue[]) =>
	[
		...new Set(
			issues.flatMap((issue) =>
				issue.code === "custom" && Object.hasOwn(HINTS, issue.message)
					? [HINTS[issue.message]!]
					: [],
			),
		),
	].join("\n");

/** A refusal the model may answer; the tool's retries apply. */
export const refusal = (
	code: string,
	extra: Readonly<Record<string, unknown>> = {},
): TaskToolResult => ({
	ok: false,
	error: code,
	...(HINTS[code] ? { detail: HINTS[code] } : {}),
	...extra,
});

/** The operation may have reached the page: no retry may follow. */
export const unretryable = (code: string): TaskToolResult => ({
	ok: false,
	error: code,
	retryable: false,
});

export const tabLine = (t: TabView) => ({
	tabRef: t.tabRef,
	title: clip(t.title ?? "", 100),
	place: placeOf(t.url ?? ""),
	active: t.current,
	// The host lists the tabs it can use; Eumenes' busy, blocked and closed tabs are not distinguished here.
	status: "idle",
});

/** An observation as the model sees it. */
export const observationView = (o: ObservationEnvelope) => ({
	observationRef: o.observationRef,
	title: clip(o.title ?? "", 200),
	place: placeOf(o.url ?? ""),
	text: o.body,
	truncated: o.truncated,
	...(o.truncationReasons.length ? { reasons: o.truncationReasons } : {}),
	refCount: o.refCount,
});

/** What the text names of the page or of the user's request is kept short: the screen shows 160 characters of it. */
export const shown = (text: string) => `「${clip(text, 40)}」`;
