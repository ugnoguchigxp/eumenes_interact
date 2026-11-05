/**
 * The network guard with a real browser (opt-in: `LAB_BROWSER_TESTS=1`, needs Chrome). A page on a name the
 * test lets through loads an image and an iframe from a loopback literal, redirects to a name that resolves
 * to loopback and offers a download: the loopback server must see none of them, and no download is accepted.
 */
import { describe, expect, test } from "bun:test";
import http from "node:http";
import dgram from "node:dgram";
import { createRequire } from "node:module";
import type net from "node:net";
import { startNetGuard } from "../../host/net-guard.ts";
import { BROWSER_LAUNCH_ARGS } from "../../../packages/eumenes-interact/src/adapters/playwright-mcp/adapter.ts";

const enabled = process.env.LAB_BROWSER_TESTS === "1";

describe.skipIf(!enabled)("net guard in Chrome", () => {
	test("subresources, iframes, redirect hops and downloads to private targets never reach them", async () => {
		const req = createRequire(
			createRequire(import.meta.url).resolve("@playwright/mcp/package.json"),
		);
		const { chromium } = req(
			"playwright-core",
		) as typeof import("playwright-core");
		const secretHits: string[] = [];
		let secretConnections = 0;
		const secret = http.createServer((q, r) => {
			secretHits.push(q.url ?? "");
			r.end("secret");
		});
		secret.on("connection", () => secretConnections++);
		await new Promise<void>((ok) => secret.listen(0, "127.0.0.1", ok));
		const sp = (secret.address() as net.AddressInfo).port;
		const page = http.createServer((q, r) => {
			if (q.url === "/worker.js") {
				r.writeHead(200, { "content-type": "text/javascript" }).end(
					`fetch("http://127.0.0.1:${sp}/worker").catch(()=>{});`,
				);
				return;
			}
			if (q.url === "/hop") {
				r.writeHead(302, { location: `http://rebind.example:${sp}/hop` }).end();
				return;
			}
			if (q.url === "/file") {
				r.writeHead(200, {
					"content-disposition": "attachment; filename=x.bin",
				}).end("x");
				return;
			}
			r.writeHead(200, { "content-type": "text/html" }).end(
				`<h1>t</h1><img src="http://127.0.0.1:${sp}/img"><iframe src="http://127.0.0.1:${sp}/frame"></iframe>
<script>
fetch("http://127.0.0.1:${sp}/fetch").catch(()=>{});
fetch("https://127.0.0.1:${sp}/tls").catch(()=>{});
new WebSocket("ws://127.0.0.1:${sp}/ws");
new Worker("/worker.js");
</script>`,
			);
		});
		await new Promise<void>((ok) => page.listen(0, "127.0.0.1", ok));
		const pp = (page.address() as net.AddressInfo).port;
		const guard = await startNetGuard({
			resolve: async (h) =>
				h === "page.example" ? ["127.0.0.1"] : ["127.0.0.2"],
			egress: (a) => a === "127.0.0.1",
		});
		const browser = await chromium.launch({
			executablePath:
				process.env.LAB_CHROME ??
				(process.platform === "darwin"
					? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
					: "/opt/google/chrome/chrome"),
			proxy: { server: guard.url },
			args: BROWSER_LAUNCH_ARGS,
			env: Object.fromEntries(
				["PATH", "HOME"].flatMap((key) =>
					process.env[key] ? [[key, process.env[key]!]] : [],
				),
			),
		});
		try {
			const ctx = await browser.newContext({
				acceptDownloads: false,
				serviceWorkers: "block",
			});
			const tab = await ctx.newPage();
			await tab.goto(`http://page.example:${pp}/`);
			await tab.waitForTimeout(1000);
			await tab.goto(`http://page.example:${pp}/hop`).catch(() => {});
			await tab.goto(`http://page.example:${pp}/file`).catch(() => {});
		} finally {
			await browser.close();
			await guard.close();
			secret.closeAllConnections();
			page.closeAllConnections();
			await Promise.all([
				new Promise<void>((r) => secret.close(() => r())),
				new Promise<void>((r) => page.close(() => r())),
			]);
		}
		expect(secretHits).toEqual([]);
		expect(secretConnections).toBe(0);
		expect(guard.blocked.map((b) => b.host)).toEqual(
			expect.arrayContaining(["127.0.0.1", "rebind.example"]),
		);
	}, 60_000);

	test("WebRTC sends no direct STUN UDP; removing the policy reaches the independent receiver", async () => {
		const req = createRequire(
			createRequire(import.meta.url).resolve("@playwright/mcp/package.json"),
		);
		const { chromium } = req(
			"playwright-core",
		) as typeof import("playwright-core");
		const receiver = dgram.createSocket("udp4");
		let hits = 0;
		receiver.on("message", () => hits++);
		await new Promise<void>((resolve) =>
			receiver.bind(0, "127.0.0.1", resolve),
		);
		const port = receiver.address().port;
		const probe = async (args: string[]) => {
			const browser = await chromium.launch({
				executablePath:
					process.env.LAB_CHROME ??
					(process.platform === "darwin"
						? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
						: "/opt/google/chrome/chrome"),
				args,
				env: Object.fromEntries(
					["PATH", "HOME"].flatMap((key) =>
						process.env[key] ? [[key, process.env[key]!]] : [],
					),
				),
			});
			try {
				const tab = await browser.newPage();
				// Fixed test-only browser code; the interpolated port comes from the local receiver.
				await tab.evaluate(`(async () => {
					const peer = new RTCPeerConnection({iceServers: [{urls: "stun:127.0.0.1:${port}"}]});
					peer.createDataChannel("synthetic-probe");
					await peer.setLocalDescription(await peer.createOffer());
					await new Promise((r) => setTimeout(r, 2000));
					peer.close();
				})()`);
			} finally {
				await browser.close();
			}
		};
		try {
			await probe(BROWSER_LAUNCH_ARGS);
			expect(hits).toBe(0);
			await probe(
				BROWSER_LAUNCH_ARGS.filter(
					(arg) => !arg.startsWith("--webrtc-ip-handling-policy="),
				),
			);
			expect(hits).toBeGreaterThan(0);
		} finally {
			await new Promise<void>((resolve) => receiver.close(resolve));
		}
	}, 30_000);
});
