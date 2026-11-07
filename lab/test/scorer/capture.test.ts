import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureRangeScore,
	captureTargetHash,
	readImageHeader,
} from "../../scorer/captures.ts";
import { scoreTrial } from "../../scorer/score.ts";
import { TranscriptBuilder, click, devCase, fixtureUrl } from "./builder.ts";

/** A PNG with a valid signature and IHDR; the pixel data is not needed to read the header. */
function png(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const view = new DataView(bytes.buffer);
	view.setUint32(8, 13);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

/** A JPEG with an APP0 segment and a baseline frame header. */
function jpeg(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(2 + 18 + 19);
	bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
	const frame = 20;
	bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], frame);
	const view = new DataView(bytes.buffer);
	view.setUint16(frame + 5, height);
	view.setUint16(frame + 7, width);
	return bytes;
}

let dir: string;
let outside: string;
beforeEach(() => {
	outside = mkdtempSync(join(tmpdir(), "capture-test-"));
	dir = join(outside, "captures");
	mkdirSync(dir);
});
afterEach(() => rmSync(outside, { recursive: true, force: true }));

const resultsUrl = fixtureUrl("sites/kaede-shop/base/results.html?q=%E9%BA%BB");
const trial = async (
	configure: (b: TranscriptBuilder) => void,
	captureDir: string | undefined = dir,
) => {
	const def = await devCase("dev-capture-results");
	const b = new TranscriptBuilder().call().step("op1", click("e1"), resultsUrl);
	configure(b);
	return scoreTrial(def, b.final("finish").build(def.id, "t", captureDir));
};

const hold = (role: string, name: string) => ({
	role,
	nameHash: captureTargetHash(name),
});
/** What the product article of dev-capture-item holds, as the host reports it (design R24). */
const ARTICLE_HOLDS = [
	hold("heading", "木のスプーン"),
	hold("img", "商品の写真"),
];

describe("readImageHeader", () => {
	test("reads PNG and JPEG sizes from the magic bytes", () => {
		expect(readImageHeader(png(800, 600))).toEqual({
			mediaType: "image/png",
			width: 800,
			height: 600,
		});
		expect(readImageHeader(jpeg(640, 480))).toEqual({
			mediaType: "image/jpeg",
			width: 640,
			height: 480,
		});
	});

	test("rejects anything else, and truncated files", () => {
		expect(readImageHeader(new TextEncoder().encode("hello"))).toBeNull();
		expect(readImageHeader(new Uint8Array())).toBeNull();
		expect(readImageHeader(png(1, 1).slice(0, 20))).toBeNull();
		expect(readImageHeader(jpeg(1, 1).slice(0, 25))).toBeNull();
		expect(readImageHeader(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBeNull();
	});
});

describe("scoreTrial: captures", () => {
	test("a valid viewport capture satisfies the case", async () => {
		writeFileSync(join(dir, "a.png"), png(800, 600));
		const score = await trial((b) => b.capture({ fileName: "a.png" }));
		expect(score.failures).toEqual([]);
		expect(score.success).toBe(true);
	});

	test("a JPEG capture with matching header is valid", async () => {
		writeFileSync(join(dir, "a.jpg"), jpeg(640, 480));
		const score = await trial((b) =>
			b.capture({
				fileName: "a.jpg",
				width: 640,
				height: 480,
				mediaType: "image/jpeg",
			}),
		);
		expect(score.success).toBe(true);
	});

	test("no capture, or only another range, is capture_missing", async () => {
		expect((await trial(() => {})).failures).toEqual(["capture_missing"]);
		writeFileSync(join(dir, "a.png"), png(800, 600));
		// dev-capture-results allows the view or the whole page, not one element.
		const other = await trial((b) =>
			b.capture({ fileName: "a.png", range: "item" }),
		);
		expect(other.failures).toEqual(["capture_missing"]);
		expect(other.captures?.wrongRange).toBe(1);
		expect(other.wrongTarget.operations).toBe(0);
	});

	test("the right page without a capture still fails, and a capture on the wrong page still fails", async () => {
		writeFileSync(join(dir, "a.png"), png(800, 600));
		const def = await devCase("dev-capture-results");
		const wrongPage = new TranscriptBuilder()
			.call()
			.step(
				"op1",
				click("e1"),
				fixtureUrl("sites/kaede-shop/base/catalog.html"),
			)
			.capture({ fileName: "a.png" })
			.final("finish")
			.build(def.id, "t", dir);
		expect(scoreTrial(def, wrongPage).failures).toEqual([
			"final_state_mismatch",
		]);
	});

	test("a file that does not exist is capture_invalid", async () => {
		const score = await trial((b) => b.capture({ fileName: "gone.png" }));
		expect(score.failures).toEqual(["capture_invalid"]);
	});

	test("file names that leave the capture folder are invalid, even if the file exists", async () => {
		writeFileSync(join(outside, "secret.png"), png(800, 600));
		for (const fileName of [
			"../secret.png",
			"sub/../../secret.png",
			join(outside, "secret.png"),
		]) {
			const score = await trial((b) => b.capture({ fileName }));
			expect(score.failures, fileName).toEqual(["capture_invalid"]);
		}
	});

	test("a symlink that points outside the capture folder is invalid", async () => {
		writeFileSync(join(outside, "secret.png"), png(800, 600));
		symlinkSync(join(outside, "secret.png"), join(dir, "link.png"));
		const score = await trial((b) => b.capture({ fileName: "link.png" }));
		expect(score.failures).toEqual(["capture_invalid"]);
	});

	test("not an image, wrong size, wrong type and empty images are invalid", async () => {
		writeFileSync(join(dir, "text.png"), "not an image at all, just text");
		writeFileSync(join(dir, "small.png"), png(10, 10));
		writeFileSync(join(dir, "real.png"), png(800, 600));
		writeFileSync(join(dir, "zero.png"), png(0, 0));
		const cases = [
			{ fileName: "text.png" },
			{ fileName: "small.png" },
			{ fileName: "real.png", mediaType: "image/jpeg" as const },
			{ fileName: "zero.png", width: 0, height: 0 },
		];
		for (const c of cases) {
			const score = await trial((b) => b.capture(c));
			expect(score.failures, c.fileName).toEqual(["capture_invalid"]);
		}
	});

	test("a transcript without a capture folder cannot validate its captures", async () => {
		const score = await trial(
			(b) => b.capture({ fileName: "a.png" }),
			undefined,
		);
		expect(score.failures).toEqual(["capture_invalid"]);
	});

	test("one invalid extra capture fails the trial even when enough valid ones exist", async () => {
		writeFileSync(join(dir, "a.png"), png(800, 600));
		const score = await trial((b) =>
			b.capture({ fileName: "a.png" }).capture({ fileName: "gone.png" }),
		);
		expect(score.failures).toEqual(["capture_invalid"]);
	});

	test("the item and full ranges are counted apart", async () => {
		writeFileSync(join(dir, "a.png"), png(800, 600));
		const def = await devCase("dev-capture-item");
		const article = {
			role: "article",
			nameHash: captureTargetHash("商品の詳細"),
		};
		const t = (range: "item" | "viewport") =>
			scoreTrial(
				def,
				new TranscriptBuilder()
					.call()
					.step(
						"op1",
						click("e1"),
						fixtureUrl("sites/kaede-shop/base/product.html?id=2"),
					)
					.capture({
						fileName: "a.png",
						range,
						target: article,
						holds: ARTICLE_HOLDS,
					})
					.final("finish")
					.build(def.id, "t", dir),
			);
		expect(t("item").success).toBe(true);
		expect(t("viewport").failures).toEqual(["capture_missing"]);
	});

	test("a request that allows several ranges counts any of them, and only those", async () => {
		writeFileSync(join(dir, "a.png"), png(800, 600));
		const def = await devCase("dev-capture-results");
		const t = (range: "viewport" | "full" | "item") =>
			scoreTrial(
				def,
				new TranscriptBuilder()
					.call()
					.step(
						"op1",
						click("e1"),
						fixtureUrl("sites/kaede-shop/base/results.html?q=麻"),
					)
					.capture({ fileName: "a.png", range })
					.final("finish")
					.build(def.id, "t", dir),
			);
		expect(t("viewport").success).toBe(true);
		expect(t("full").success).toBe(true);
		expect(t("item").failures).toEqual(["capture_missing"]);
	});

	test("an element capture counts only when it is of the expected element", async () => {
		writeFileSync(join(dir, "a.png"), png(400, 300));
		const def = await devCase("dev-capture-item");
		const t = (target?: { role: string; nameHash: string }) =>
			scoreTrial(
				def,
				new TranscriptBuilder()
					.call()
					.step(
						"op1",
						click("e1"),
						fixtureUrl("sites/kaede-shop/base/product.html?id=2"),
					)
					.capture({
						fileName: "a.png",
						width: 400,
						height: 300,
						range: "item",
						holds: ARTICLE_HOLDS,
						...(target ? { target } : {}),
					})
					.final("finish")
					.build(def.id, "t", dir),
			);
		// The recommendations beside the product, and its photo, are not the product part.
		expect(
			t({ role: "complementary", nameHash: captureTargetHash("おすすめ") })
				.failures,
		).toEqual(["capture_missing"]);
		expect(
			t({ role: "img", nameHash: captureTargetHash("商品の写真") }).failures,
		).toEqual(["capture_missing"]);
		expect(t().failures).toEqual(["capture_missing"]);
		expect(
			t({ role: "article", nameHash: captureTargetHash(" 商品の詳細 ") })
				.success,
		).toBe(true);
	});
});

describe("scoreTrial: what a captured block holds (F11)", () => {
	// "Only the product part" on the product page: the intended block is the article (target); it must hold the
	// name and the photo, and must not hold the recommendations beside it.
	const article = hold("article", "商品の詳細");
	const run = async (
		target: { role: string; nameHash: string },
		holds: { role: string; nameHash: string }[] | undefined,
		holdsCount?: number,
	) => {
		writeFileSync(join(dir, "a.png"), png(400, 300));
		const def = await devCase("dev-capture-item");
		return scoreTrial(
			def,
			new TranscriptBuilder()
				.call()
				.step(
					"op1",
					click("e1"),
					fixtureUrl("sites/kaede-shop/base/product.html?id=2"),
				)
				.capture({
					fileName: "a.png",
					width: 400,
					height: 300,
					range: "item",
					target,
					...(holds ? { holds } : {}),
					...(holdsCount === undefined ? {} : { holdsCount }),
				})
				.final("finish")
				.build(def.id, "t", dir),
		);
	};

	test("the intended block with everything wanted and nothing unwanted passes", async () => {
		expect((await run(article, ARTICLE_HOLDS)).success).toBe(true);
	});

	test("the whole main region holds the recommendations too: the right content, the wrong range", async () => {
		const main = hold("main", "");
		const score = await run(main, [
			...ARTICLE_HOLDS,
			hold("article", "商品の詳細"),
			hold("complementary", "おすすめ"),
			hold("heading", "こちらもどうぞ"),
			hold("link", "陶器の小皿"),
		]);
		expect(score.failures).toEqual(["capture_missing"]);
	});

	test("the photo alone leaves out the name, and an unreported range cannot be confirmed", async () => {
		expect((await run(hold("img", "商品の写真"), [])).failures).toEqual([
			"capture_missing",
		]);
		expect((await run(article, undefined)).failures).toEqual([
			"capture_missing",
		]);
	});

	test("the article with the recommendations inside is rejected for the unwanted part", async () => {
		const score = await run(article, [
			...ARTICLE_HOLDS,
			hold("complementary", "おすすめ"),
		]);
		expect(score.failures).toEqual(["capture_missing"]);
	});

	test("captureRangeScore names what is missing and what is extra", async () => {
		const event = {
			type: "capture.saved" as const,
			at: 0,
			captureId: "c1",
			fileName: "a.png",
			width: 1,
			height: 1,
			bytes: 1,
			mediaType: "image/png" as const,
			range: "item" as const,
			holds: [hold("heading", "木のスプーン"), hold("link", "陶器の小皿")],
			holdsCount: 30,
		};
		expect(
			captureRangeScore(event, {
				includes: [
					{ role: "heading", name: "木のスプーン" },
					{ role: "img", name: "商品の写真" },
				],
				excludes: [{ role: "link", name: "陶器の小皿" }],
			}),
		).toEqual({
			missing: [{ role: "img", name: "商品の写真" }],
			extra: [{ role: "link", name: "陶器の小皿" }],
			unconfirmed: true,
			ok: false,
		});
	});
});
