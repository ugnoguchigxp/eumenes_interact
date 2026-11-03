import { expect, test } from "bun:test";
import {
	IMAGE_MAX_SIDE,
	imageInfo,
	withinBounds,
} from "../../../src/adapters/mcp/image.ts";
import { jpeg, png } from "./images.ts";

test("a PNG's size comes from its IHDR", () => {
	expect(imageInfo(png(1280, 720))).toEqual({
		mediaType: "image/png",
		width: 1280,
		height: 720,
	});
	expect(imageInfo(png(1, 16384))).toMatchObject({ width: 1, height: 16384 });
});

test("a JPEG's size comes from its first start of frame, past other segments", () => {
	expect(imageInfo(jpeg(800, 600))).toEqual({
		mediaType: "image/jpeg",
		width: 800,
		height: 600,
	});
	// Progressive (SOF2) is read the same; the table marker 0xC4 is not a frame.
	expect(imageInfo(jpeg(321, 123, 0xc2))).toMatchObject({
		width: 321,
		height: 123,
	});
});

test("anything that is not a complete header is not an image", () => {
	const good = png(10, 10);
	for (const bad of [
		new Uint8Array(),
		new Uint8Array([0x89, 0x50]),
		good.slice(0, 23),
		(() => {
			const wrong = good.slice();
			wrong[0] = 0;
			return wrong;
		})(),
		(() => {
			const wrong = good.slice();
			wrong[15] = 0x58; // not IHDR
			return wrong;
		})(),
		new TextEncoder().encode("GIF89a........................"),
		new Uint8Array([0xff, 0xd8]),
		new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]),
		// A frame that ends before its dimensions.
		new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00]),
		// A segment with an impossible length.
		new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]),
	])
		expect(imageInfo(bad)).toBeUndefined();
});

test("sizes are positive and at most the hard bound per side", () => {
	const info = (width: number, height: number) =>
		imageInfo(png(width, height)) as NonNullable<ReturnType<typeof imageInfo>>;
	expect(withinBounds(info(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE))).toBe(true);
	expect(withinBounds(info(0, 10))).toBe(false);
	expect(withinBounds(info(10, 0))).toBe(false);
	expect(withinBounds(info(IMAGE_MAX_SIDE + 1, 10))).toBe(false);
	expect(withinBounds(info(10, IMAGE_MAX_SIDE + 1))).toBe(false);
	expect(withinBounds(info(4_294_967_295, 10))).toBe(false);
});

test("standalone markers before the frame carry no length and are stepped over", () => {
	const plain = jpeg(640, 480);
	// SOI, then a restart marker (RST0) and TEM, then the rest as usual.
	const withStandalone = new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xd0,
		0xff,
		0x01,
		...plain.subarray(2),
	]);
	expect(imageInfo(withStandalone)).toEqual({
		mediaType: "image/jpeg",
		width: 640,
		height: 480,
	});
});
