import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES_DIR } from "../../cases/load.ts";
import { createFixtureHandler } from "../../host/fixture-server.ts";

/** The request handler is called directly: no port is bound in tests. */
const get = (
	handler: ReturnType<typeof createFixtureHandler>,
	path: string,
	init?: RequestInit,
) => handler(new Request(`http://127.0.0.1:1${path}`, init));

describe("fixture handler on the real fixtures", () => {
	const handler = createFixtureHandler(FIXTURES_DIR);

	test("serves an html page with its content type and no caching", async () => {
		const res = await get(handler, "/sites/hoshikuzu/base/index.html");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await res.text()).toContain("星屑堂書店");
	});

	test("serves css and js with their types; the query is ignored", async () => {
		expect(
			(await get(handler, "/sites/hoshikuzu/site.css")).headers.get(
				"content-type",
			),
		).toBe("text/css; charset=utf-8");
		const js = await get(handler, "/sites/hoshikuzu/shop.js?x=1");
		expect(js.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		);
	});

	test("HEAD has headers and no body; other methods are refused", async () => {
		const head = await get(handler, "/sites/hoshikuzu/base/index.html", {
			method: "HEAD",
		});
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
			const res = await get(handler, "/sites/hoshikuzu/base/index.html", {
				method,
			});
			expect(res.status).toBe(405);
			expect(res.headers.get("allow")).toBe("GET, HEAD");
		}
	});

	test("no directory listing", async () => {
		for (const path of ["/", "/sites", "/sites/", "/sites/hoshikuzu/base"])
			expect((await get(handler, path)).status).toBe(404);
	});

	test.each([
		"/sites/../package.json",
		"/%2e%2e/package.json",
		"/sites/%2e%2e/%2e%2e/package.json",
		"/sites%2f..%2f..%2fpackage.json",
		"/sites/hoshikuzu/base/..%5c..%5cindex.html",
		"/sites/hoshikuzu/base/index.html%00.png",
		"/%",
	])("%s is refused", async (path) => {
		const res = await get(handler, path);
		expect([400, 404]).toContain(res.status);
		expect(res.headers.get("content-type")).toBeNull();
	});

	test("a missing file is 404", async () => {
		expect((await get(handler, "/sites/nope.html")).status).toBe(404);
	});
});

describe("fixture handler and symlinks", () => {
	let dir = "";
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "interact-fixture-test-"));
		mkdirSync(join(dir, "root", "sub"), { recursive: true });
		writeFileSync(join(dir, "root", "sub", "a.html"), "<p>a</p>");
		writeFileSync(join(dir, "secret.txt"), "secret");
		symlinkSync(join(dir, "secret.txt"), join(dir, "root", "leak.txt"));
		symlinkSync(dir, join(dir, "root", "outside"));
		symlinkSync(
			join(dir, "root", "sub", "a.html"),
			join(dir, "root", "inside.html"),
		);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("a symlink out of the root is refused, one that stays inside is served", async () => {
		const handler = createFixtureHandler(join(dir, "root"));
		expect((await get(handler, "/leak.txt")).status).toBe(404);
		expect((await get(handler, "/outside/secret.txt")).status).toBe(404);
		const inside = await get(handler, "/inside.html");
		expect(inside.status).toBe(200);
		expect(await inside.text()).toBe("<p>a</p>");
	});

	test("an unknown extension is served as opaque bytes", async () => {
		writeFileSync(join(dir, "root", "x.bin"), "x");
		const res = await get(createFixtureHandler(join(dir, "root")), "/x.bin");
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
	});
});
