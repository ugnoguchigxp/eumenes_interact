import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_MAX_BYTES } from "../../../src/adapters/mcp/image.ts";
import type { McpToolResult } from "../../../src/adapters/mcp/common.ts";
import { jpeg, png } from "../mcp/images.ts";
import { cleanup, failure, hang, NEVER, opened, setup, text } from "./fakes.ts";

afterEach(cleanup);

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A screenshot answer as MCP sends it: the result section with the file link, and the image content. */
const shot = (
	bytes: Uint8Array,
	mimeType = "image/png",
	link = "./page-2026-11-03T10-00-00-000Z.png",
): McpToolResult => ({
	content: [
		{
			type: "text",
			text: `### Result\n- [Screenshot of viewport](${link})\n### Ran Playwright code\n\`\`\`js\n// Screenshot viewport\n\`\`\``,
		},
		{ type: "image", data: b64(bytes), mimeType },
	],
});

test("each range asks for a PNG in CSS pixels and nothing that writes outside the output dir", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = () => shot(png(640, 480));
	await adapter.capture("viewport", null, NEVER);
	await adapter.capture("full", null, NEVER);
	await adapter.capture("item", "f1e7", NEVER);
	expect(fake.calls().slice(1)).toEqual([
		{
			name: "browser_take_screenshot",
			arguments: { type: "png", scale: "css" },
		},
		{
			name: "browser_take_screenshot",
			arguments: { type: "png", scale: "css", fullPage: true },
		},
		{
			name: "browser_take_screenshot",
			arguments: {
				type: "png",
				scale: "css",
				target: "f1e7",
				element: "captured element",
			},
		},
	]);
	// No filename: MCP writes into its own output dir only, and no other tool is involved.
	for (const call of fake.calls().slice(1))
		expect(call.arguments).not.toHaveProperty("filename");
});

test("the image is returned with its type and size read from its own header", async () => {
	const { adapter, fake } = await opened();
	const image = png(1280, 720);
	fake.onTool = () => shot(image);
	const captured = await adapter.capture("viewport", null, NEVER);
	expect(captured).toEqual({
		mediaType: "image/png",
		bytes: image,
		width: 1280,
		height: 720,
	});
	expect(captured.bytes).toBeInstanceOf(Uint8Array);
	// A JPEG, declared as one, is accepted too.
	const photo = jpeg(800, 600);
	fake.onTool = () => shot(photo, "image/jpeg");
	expect(await adapter.capture("full", null, NEVER)).toEqual({
		mediaType: "image/jpeg",
		bytes: photo,
		width: 800,
		height: 600,
	});
});

test("an image the header does not describe, or that is out of bounds, is rejected", async () => {
	const { adapter, fake } = await opened();
	const rejected = async (result: McpToolResult, label: string) => {
		fake.onTool = () => result;
		await expect(
			adapter.capture("viewport", null, NEVER),
			label,
		).rejects.toMatchObject({
			code: "mcp_response_unrecognized",
			dispatched: false,
		});
	};
	await rejected(shot(png(0, 480)), "zero width");
	await rejected(shot(png(640, 0)), "zero height");
	await rejected(shot(png(16385, 10)), "too wide");
	await rejected(shot(png(10, 16385)), "too tall");
	await rejected(shot(png(10, 10).slice(0, 20)), "truncated header");
	await rejected(
		shot(new TextEncoder().encode("not an image")),
		"not an image",
	);
	await rejected(shot(new Uint8Array()), "empty");
	await rejected(shot(png(10, 10), "image/jpeg"), "declared jpeg, bytes png");
	await rejected(shot(jpeg(10, 10), "image/png"), "declared png, bytes jpeg");
	await rejected(shot(png(10, 10), "image/webp"), "webp is not accepted");
	await rejected(text("### Result\nno image"), "no image and no file");
	// More bytes than the bound, even with a valid header.
	const huge = new Uint8Array(IMAGE_MAX_BYTES + 1);
	huge.set(png(10, 10));
	await rejected(shot(huge), "over the byte bound");
	// Exactly the bound is accepted.
	const exact = new Uint8Array(IMAGE_MAX_BYTES);
	exact.set(png(10, 10));
	fake.onTool = () => shot(exact);
	expect((await adapter.capture("viewport", null, NEVER)).bytes).toHaveLength(
		IMAGE_MAX_BYTES,
	);
	// The largest side allowed.
	fake.onTool = () => shot(png(16384, 16384));
	expect(await adapter.capture("full", null, NEVER)).toMatchObject({
		width: 16384,
		height: 16384,
	});
});

test("when MCP sends no image content, the file it wrote is the image, and it is deleted", async () => {
	const { adapter, fake, workDir } = await opened();
	const outputDir = join(workDir, "playwright-mcp-output");
	const image = png(300, 200);
	fake.onTool = () => {
		writeFileSync(join(outputDir, "page-1.png"), image);
		writeFileSync(join(outputDir, "console-1.log"), "page text");
		return text(
			"### Result\n- [Screenshot of viewport](/anywhere/else/page-1.png)",
		);
	};
	expect(await adapter.capture("viewport", null, NEVER)).toEqual({
		mediaType: "image/png",
		bytes: image,
		width: 300,
		height: 200,
	});
	expect(readdirSync(outputDir)).toEqual([]);
	// A link can only name a file in the output dir; one that is not there is an error.
	fake.onTool = () =>
		text("### Result\n- [Screenshot of viewport](../../etc/passwd)");
	await expect(adapter.capture("viewport", null, NEVER)).rejects.toMatchObject({
		code: "screenshot_file_missing",
		dispatched: false,
	});
	// Files MCP wrote next to image content are removed too.
	fake.onTool = () => {
		writeFileSync(join(outputDir, "page-2.png"), image);
		return shot(image);
	};
	await adapter.capture("viewport", null, NEVER);
	expect(existsSync(join(outputDir, "page-2.png"))).toBe(false);
	expect(readdirSync(outputDir)).toEqual([]);
});

test("the range and the ref must fit: item needs an observed ref, the others have none", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = () => shot(png(10, 10));
	const before = fake.calls().length;
	for (const ref of [null, "", "body > a", "E4", "e4; x", "@e4"])
		await expect(adapter.capture("item", ref, NEVER)).rejects.toMatchObject({
			code: "invalid_ref",
			dispatched: false,
		});
	for (const range of ["viewport", "full"] as const)
		await expect(adapter.capture(range, "e4", NEVER)).rejects.toMatchObject({
			code: "invalid_ref",
			dispatched: false,
		});
	await expect(
		adapter.capture("sideways" as never, null, NEVER),
	).rejects.toMatchObject({ code: "invalid_range", dispatched: false });
	expect(fake.calls().length).toBe(before);
});

test("errors never reached the page; abort and a closed session end it cleanly", async () => {
	const { adapter, fake } = await opened();
	fake.onTool = () =>
		failure(
			"Ref e9 not found in the current page snapshot. Try capturing new snapshot.",
		);
	await expect(adapter.capture("item", "e9", NEVER)).rejects.toMatchObject({
		code: "stale_ref",
		dispatched: false,
	});
	fake.onTool = () => failure("Error: something unexpected");
	await expect(adapter.capture("viewport", null, NEVER)).rejects.toMatchObject({
		dispatched: false,
	});
	fake.onTool = hang;
	const controller = new AbortController();
	const pending = adapter.capture("full", null, controller.signal);
	await Bun.sleep(20);
	controller.abort();
	await expect(pending).rejects.toMatchObject({
		code: "cancelled",
		dispatched: false,
	});
	const before = fake.calls().length;
	const early = new AbortController();
	early.abort();
	await expect(
		adapter.capture("viewport", null, early.signal),
	).rejects.toMatchObject({ code: "cancelled", dispatched: false });
	expect(fake.calls().length).toBe(before);
	await adapter.close();
	await expect(adapter.capture("viewport", null, NEVER)).rejects.toMatchObject({
		code: "not_open",
		dispatched: false,
	});
});

test("only the screenshot tool is called, and the log carries the duration and byte count alone", async () => {
	const { adapter, fake, events } = await opened();
	fake.onTool = () => shot(png(640, 480));
	await adapter.capture("viewport", null, NEVER);
	await adapter.capture("item", "e4", NEVER);
	expect([...new Set(fake.toolNames().slice(1))]).toEqual([
		"browser_take_screenshot",
	]);
	const observed = events.filter(([name]) => name === "adapter.observed");
	expect(observed).toHaveLength(2);
	for (const [, fields] of observed)
		expect(fields).toEqual({
			correlationId: "corr-1",
			count: png(640, 480).length,
			durationMs: expect.any(Number),
		});
	fake.onTool = () => shot(png(0, 0));
	await adapter.capture("viewport", null, NEVER).catch(() => {});
	expect(events.at(-1)).toEqual([
		"adapter.failed",
		{
			correlationId: "corr-1",
			code: "mcp_response_unrecognized",
			durationMs: expect.any(Number),
		},
	]);
	// The image bytes and the page never reach the log.
	expect(JSON.stringify(events)).not.toContain(b64(png(640, 480)));
});

test("capture does not start a child by itself", async () => {
	const ctx = setup();
	await expect(
		ctx.adapter.capture("viewport", null, NEVER),
	).rejects.toMatchObject({
		code: "not_open",
	});
	expect(ctx.launches).toHaveLength(0);
});
