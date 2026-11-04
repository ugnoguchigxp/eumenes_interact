/**
 * The network guard with a real browser (opt-in: `LAB_BROWSER_TESTS=1`, needs Chrome). A page on a name the
 * test lets through loads an image and an iframe from a loopback literal, redirects to a name that resolves
 * to loopback and offers a download: the loopback server must see none of them, and no download is accepted.
 */
import { describe, expect, test } from "bun:test";
import http from "node:http";
import { createRequire } from "node:module";
import type net from "node:net";
import { startNetGuard } from "../../host/net-guard.ts";

const enabled = process.env.LAB_BROWSER_TESTS === "1";

describe.skipIf(!enabled)("net guard in Chrome", () => {
	test("subresources, iframes, redirect hops and downloads to private targets never reach them", async () => {
		const req = createRequire(createRequire(import.meta.url).resolve("@playwright/mcp/package.json"));
		const { chromium } = req("playwright-core") as typeof import("playwright-core");
		const secretHits: string[] = [];
		const secret = http.createServer((q, r) => {
			secretHits.push(q.url ?? "");
			r.end("secret");
		});
		await new Promise<void>((ok) => secret.listen(0, "127.0.0.1", ok));
		const sp = (secret.address() as net.AddressInfo).port;
		const page = http.createServer((q, r) => {
			if (q.url === "/hop") {
				r.writeHead(302, { location: `http://rebind.example:${sp}/hop` }).end();
				return;
			}
			if (q.url === "/file") {
				r.writeHead(200, { "content-disposition": "attachment; filename=x.bin" }).end("x");
				return;
			}
			r.writeHead(200, { "content-type": "text/html" }).end(
				`<h1>t</h1><img src="http://127.0.0.1:${sp}/img"><iframe src="http://127.0.0.1:${sp}/frame"></iframe>`,
			);
		});
		await new Promise<void>((ok) => page.listen(0, "127.0.0.2", ok));
		const pp = (page.address() as net.AddressInfo).port;
		const guard = await startNetGuard({
			resolve: async (h) => (h === "page.example" ? ["127.0.0.2"] : ["127.0.0.1"]),
			egress: (a) => a === "127.0.0.2",
		});
		const browser = await chromium.launch({
			executablePath: process.env.LAB_CHROME ?? "/opt/google/chrome/chrome",
			proxy: { server: guard.url },
		});
		const ctx = await browser.newContext({ acceptDownloads: false });
		const tab = await ctx.newPage();
		await tab.goto(`http://page.example:${pp}/`);
		await tab.waitForTimeout(1000);
		await tab.goto(`http://page.example:${pp}/hop`).catch(() => {});
		await tab.goto(`http://page.example:${pp}/file`).catch(() => {});
		await browser.close();
		await guard.close();
		secret.close();
		page.close();
		expect(secretHits).toEqual([]);
		expect(guard.blocked.map((b) => b.host)).toEqual(
			expect.arrayContaining(["127.0.0.1", "rebind.example"]),
		);
	}, 60_000);
});
