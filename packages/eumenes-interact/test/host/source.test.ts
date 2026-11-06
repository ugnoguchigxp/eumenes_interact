import { describe, expect, test } from "bun:test";
import {
	assertChoiceQuoted,
	assertQuoted,
	assertValueQuoted,
	choiceSourced,
	containsAtWordEdge,
	effectOf,
	grantOrigin,
	impliedQuote,
	InputGrants,
	querySourced,
} from "../../src/parts.ts";

/** Whether the rule lets it through (a refusal is the only failure these functions have). */
const passes = (check: () => void) => {
	try {
		check();
		return true;
	} catch {
		return false;
	}
};

describe("word edges", () => {
	test("a Latin word does not match inside a longer word; Japanese has no such edge", () => {
		expect(containsAtWordEdge("yesterday", "yes")).toBe(false);
		expect(containsAtWordEdge("yes, please", "yes")).toBe(true);
		expect(containsAtWordEdge("information", "tion")).toBe(false);
		expect(containsAtWordEdge("ギフト包装あり", "ギフト包装")).toBe(true);
		expect(containsAtWordEdge("11月21日に", "11月21日")).toBe(true);
		expect(containsAtWordEdge("a1", "1")).toBe(false);
	});

	test("other scripts written with spaces have word edges too", () => {
		expect(containsAtWordEdge("нужно ли: дальше", "да")).toBe(false);
		expect(containsAtWordEdge("да, нужно", "да")).toBe(true);
		expect(containsAtWordEdge("예약하기", "예")).toBe(false);
		expect(containsAtWordEdge("예, 좋아요", "예")).toBe(true);
	});

	test("the long vowel mark is part of a word, a dash only between digits", () => {
		expect(
			passes(() => assertValueQuoted("ビル", "ビル", "ビールを探して")),
		).toBe(false);
		expect(
			passes(() =>
				assertValueQuoted(
					"09012345678",
					"090ー1234ー5678",
					"電話は090ー1234ー5678",
				),
			),
		).toBe(true);
	});
});

describe("typed values", () => {
	const request = "電話番号は09012345678、検索語は白波です。";

	test("a value inside a passage of the request passes, with or without separators", () => {
		expect(passes(() => assertValueQuoted("白波", "白波", request))).toBe(true);
		expect(
			passes(() => assertValueQuoted("090-1234-5678", "09012345678", request)),
		).toBe(true);
	});

	test("a real passage does not carry a value it does not hold", () => {
		expect(
			passes(() =>
				assertValueQuoted("https://evil.example/?d=x", "白波", request),
			),
		).toBe(false);
		// The 0.1.x name keeps the same, stricter rule.
		expect(
			passes(() => assertQuoted("https://evil.example/?d=x", "白波", request)),
		).toBe(false);
	});

	test("a passage that is not the request's, or too short, is refused", () => {
		expect(passes(() => assertValueQuoted("黒潮", "黒潮", request))).toBe(
			false,
		);
		expect(passes(() => assertValueQuoted("白", "白", request))).toBe(false);
		expect(passes(() => assertValueQuoted("", "白波", request))).toBe(false);
	});
});

describe("choices", () => {
	test("the user's words covering most of an option choose it", () => {
		expect(
			passes(() =>
				assertChoiceQuoted(
					"11月21日（土）",
					"11月21日",
					"11月21日に予約したい",
				),
			),
		).toBe(true);
	});

	test("a word the request only contains inside another word chooses nothing", () => {
		const request = "Please send me more information about the order.";
		expect(
			choiceSourced("I agree to the terms and conditions", request, {}),
		).toBe(false);
		expect(choiceSourced("Yes", "I came yesterday", {})).toBe(false);
		expect(choiceSourced("None", "no thanks", { value: "no" })).toBe(false);
	});

	test("a short quote does not tick a long label it barely covers", () => {
		expect(
			passes(() =>
				assertChoiceQuoted(
					"I agree to the terms and conditions",
					"terms",
					"what are the terms?",
				),
			),
		).toBe(false);
	});

	test("a quote the model gave must hold by itself: it is not replaced by a guess", () => {
		const request = "ギフト包装ありでお願いします。贈り物です。";
		expect(
			choiceSourced("ギフト包装にする", request, { quote: "贈り物" }),
		).toBe(false);
		expect(
			choiceSourced("ギフト包装にする", request, { quote: "ギフト包装" }),
		).toBe(true);
	});

	test("without a quote, the passage the label shares with the request ties them", () => {
		const request = "商品は木のスプーン、ギフト包装あり、お届けはお急ぎ便で。";
		expect(impliedQuote("ギフト包装にする", request)).toBe("ギフト包装");
		expect(choiceSourced("ギフト包装にする", request, {})).toBe(true);
		expect(choiceSourced("お急ぎ便", request, {})).toBe(true);
		expect(choiceSourced("メールマガジンを受け取る", request, {})).toBe(false);
		// A label too long to be a choice's name is not searched (the search is quadratic).
		expect(impliedQuote("あ".repeat(201), "あ".repeat(201))).toBeNull();
	});

	test("an option is also named by the request's words the model gave as its value", () => {
		expect(
			choiceSourced("木のスプーン", "木のスプーンを1本", {
				value: "木のスプーン",
			}),
		).toBe(true);
		expect(
			choiceSourced("木のスプーン", "木のスプーンを1本", {
				value: "鉄のフォーク",
			}),
		).toBe(true); // the label itself is still in the request
		expect(
			choiceSourced("鉄のフォーク", "木のスプーンを1本", {
				value: "鉄のフォーク",
			}),
		).toBe(false);
	});
});

describe("search words", () => {
	test("every word needs a source; a one-character word must stand as a word", () => {
		expect(querySourced("白波 酒造", ["白波酒造の営業時間"])).toBe(true);
		expect(querySourced("白波 黒潮", ["白波酒造の営業時間"])).toBe(false);
		expect(querySourced("a", ["plan a trip"])).toBe(true);
		expect(querySourced("a", ["banana"])).toBe(false);
		expect(querySourced("", ["anything"])).toBe(false);
	});
});

describe("grants", () => {
	test("a value is bound only to an https site, or to plain http on loopback", () => {
		expect(grantOrigin("https://shop.example/a")).toBe("https://shop.example");
		expect(grantOrigin("http://127.0.0.1:8080/x")).toBe(
			"http://127.0.0.1:8080",
		);
		expect(grantOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
		expect(grantOrigin("http://shop.example/a")).toBeNull();
		expect(grantOrigin("ftp://shop.example/")).toBeNull();
	});

	test("expired grants are dropped when the next one is approved", () => {
		let now = 0;
		let n = 0;
		const grants = new InputGrants(
			() => now,
			() => `ref-${++n}`,
		);
		const first = grants.approve({
			value: "古い値",
			origin: "https://shop.example",
			purpose: "検索語",
		});
		now = 11 * 60_000;
		grants.approve({
			value: "新しい値",
			origin: "https://shop.example",
			purpose: "検索語",
		});
		// Expired, but kept for one more period: the use still says why it failed.
		expect(() =>
			grants.use(first.inputValueRef, "https://shop.example/x"),
		).toThrow("grant_expired");
		expect(grants.find("古い値", "https://shop.example/x")).toBeNull();
		expect(grants.find("新しい値", "https://shop.example/x")).toBe("ref-2");
		now = 21 * 60_000;
		grants.approve({
			value: "三つ目",
			origin: "https://shop.example",
			purpose: "検索語",
		});
		expect(() =>
			grants.use(first.inputValueRef, "https://shop.example/x"),
		).toThrow("grant_not_found");
	});
});

describe("what item.open declares (R05)", () => {
	test("a link or menu item navigates only when it has a destination of its own", () => {
		expect(effectOf({ role: "link", url: "https://shop.example/a" })).toBe(
			"navigation",
		);
		expect(effectOf({ role: "link", url: "apply.html" })).toBe("navigation");
		expect(effectOf({ role: "link" })).toBe("submit");
		expect(effectOf({ role: "link", url: "#" })).toBe("submit");
		expect(effectOf({ role: "link", url: "javascript:void(0)" })).toBe(
			"submit",
		);
		expect(effectOf({ role: "link", url: "java\nscript:void(0)" })).toBe(
			"submit",
		);
		expect(effectOf({ role: "link", url: " \tjavascript:x" })).toBe("submit");
		expect(effectOf({ role: "menuitem" })).toBe("submit");
		expect(effectOf({ role: "menuitem", url: "/settings" })).toBe("navigation");
	});

	test("a tab switches the page's view; a button always submits; other roles are not opened", () => {
		expect(effectOf({ role: "tab" })).toBe("navigation");
		expect(effectOf({ role: "button", url: "/x" })).toBe("submit");
		expect(effectOf({ role: "heading" })).toBeUndefined();
	});
});
