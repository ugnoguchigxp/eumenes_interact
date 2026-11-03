import { z } from "zod";

/**
 * The input schemas of the page operator's tools, ported from Eumenes `api/domains/capabilities/contracts/
 * browser.ts` and `inputs.ts` (commit 98b188d2) with the same shapes and descriptions: `z.toJSONSchema` of them
 * is what the model reads in TOOLS. The model fills these flat objects; element refs come with the observation
 * they were read from, and typed text only as a value quoted from the request.
 */

const tabRef = z.uuid();
const guid = z.guid();
const observationRef = z.uuid().describe("直近の観測のobservationRef");
const elementRef = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,32}$/)
	.describe("観測textの[ref=eN]のeN");
const elementName = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.describe("要素の名前と役割（観測の表示どおり）");
const effect = z
	.enum(["navigate", "input", "commit"])
	.describe(
		"操作の影響。navigate=閲覧・移動・検索、input=入力欄の選択や値の入力、commit=送信・購入・公開・削除・保存（Eumenes自身の画面での保存を含む）",
	);

export const emptyInput = z.strictObject({});
/** A tab of the tab list. */
export const browserTabTarget = z.object({ tabRef }).strict();
/** A URL for a new tab or the current one; the host checks where it may go. */
export const browserTabOpen = z
	.object({ url: z.string().trim().min(1).max(2048) })
	.strict();
export const browserPageClick = z
	.object({
		observationRef,
		ref: elementRef,
		element: elementName,
		effect,
	})
	.strict();
export const browserPageHover = z
	.object({ observationRef, ref: elementRef, element: elementName })
	.strict();
export const browserPageSelect = z
	.object({
		observationRef,
		ref: elementRef,
		element: elementName,
		values: z.array(z.string().min(1).max(500)).min(1).max(20),
	})
	.strict();
export const browserPagePress = z
	.object({
		key: z
			.string()
			.regex(/^[A-Za-z0-9+]{1,40}$/)
			.describe("キー名（Enter、Escape、ArrowDownなど）"),
		effect,
	})
	.strict();
export const browserPageWait = z
	.object({
		text: z.string().min(1).max(200).optional().describe("現れるのを待つ文字"),
		textGone: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.describe("消えるのを待つ文字"),
		seconds: z.number().gt(0).max(30).optional().describe("待つ秒数"),
	})
	.strict()
	.refine((w) => w.text || w.textGone || w.seconds, "wait_condition");

const variableName = z.string().regex(/^[a-z][a-zA-Z0-9]{0,30}$/);
const typeTarget = {
	observationRef: guid.describe("直近の観測のobservationRef"),
	ref: elementRef,
	element: elementName,
	variable: variableName
		.optional()
		.describe("Scriptの変数名。使うときvalue・quoteは書かない"),
	value: z.string().min(1).max(2000).optional().describe("入力する値"),
	quote: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.optional()
		.describe("valueの元にした、利用者の原文にある一節（原文のまま）"),
	purpose: z.string().trim().min(1).max(60).describe("入力の用途の短い語"),
	submit: z.boolean().describe("入力後にEnterを押すか"),
	effect: effect.optional().describe("submitがtrueのときは必須"),
};
/** `type` with a request quotation (or a Script variable, which this core refuses: no Script exists). */
export const browserPageType2 = z
	.object(typeTarget)
	.strict()
	.refine(
		(t) => (t.variable ? !t.value && !t.quote : !!t.value && !!t.quote),
		"value_source",
	);
/** `type` that can also type a value the user approved: exactly one of the three sources. */
export const browserPageTypeValue2 = z
	.object({
		...typeTarget,
		inputValueRef: guid
			.optional()
			.describe("approvedの入力値。使うときvalue・quote・variableは書かない"),
	})
	.strict()
	.refine(
		(t) =>
			t.inputValueRef || t.variable
				? !t.value && !t.quote && !(t.inputValueRef && t.variable)
				: !!t.value && !!t.quote,
		"value_source",
	);
