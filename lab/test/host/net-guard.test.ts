import { describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import {
	cidrMatcher,
	isPrivateAddress,
	resolvePublic,
	startNetGuard,
} from "../../host/net-guard.ts";

describe("isPrivateAddress", () => {
	test.each([
		"127.0.0.1",
		"10.1.2.3",
		"192.168.0.1",
		"169.254.169.254",
		"0.0.0.0",
		"100.64.0.1",
		"::1",
		"::",
		"fe80::1",
		"fc00::1",
		"fd12:3456::1",
		"ff02::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:10.0.0.1",
		"64:ff9b::a9fe:a9fe",
		"2002:c0a8:0001::1",
		"not-an-ip",
	])("%s is private", (a) => expect(isPrivateAddress(a)).toBe(true));
	test.each([
		"93.184.216.34",
		"8.8.8.8",
		"2606:4700::1111",
		"::ffff:8.8.8.8",
		"2002:0808:0808::1",
	])("%s is public", (a) => expect(isPrivateAddress(a)).toBe(false));
});

describe("resolvePublic", () => {
	const fake = (map: Record<string, string[]>) => async (h: string) => {
		const v = map[h];
		if (!v) throw new Error("ENOTFOUND");
		return v;
	};
	test("a name resolving to a private address is refused", async () => {
		expect(
			await resolvePublic(
				"evil.example",
				fake({ "evil.example": ["93.184.216.34", "127.0.0.1"] }),
			),
		).toEqual({
			ok: false,
			code: "navigation_private_resolved",
		});
		expect(
			await resolvePublic(
				"v6.example",
				fake({ "v6.example": ["::ffff:192.168.1.1"] }),
			),
		).toMatchObject({ ok: false });
	});
	test("a public name gives the checked address", async () => {
		expect(
			await resolvePublic(
				"ok.example",
				fake({ "ok.example": ["93.184.216.34"] }),
			),
		).toEqual({
			ok: true,
			address: "93.184.216.34",
		});
	});
	test("names refused by name and unresolvable names", async () => {
		expect(await resolvePublic("localhost", fake({}))).toMatchObject({
			ok: false,
			code: "navigation_private_blocked",
		});
		expect(await resolvePublic("x.nip.io", fake({}))).toMatchObject({
			ok: false,
		});
		expect(await resolvePublic("gone.example", fake({}))).toMatchObject({
			ok: false,
			code: "navigation_dns_failed",
		});
		expect(await resolvePublic("[::1]", fake({}))).toMatchObject({ ok: false });
	});
});

describe("startNetGuard", () => {
	test.each(["http", "connect"])(
		"%s can use the second checked address without resolving again",
		async (protocol) => {
			const target = http.createServer((_q, r) =>
				r.end("public test endpoint"),
			);
			await new Promise<void>((ok) => target.listen(0, "127.0.0.1", ok));
			const port = (target.address() as net.AddressInfo).port;
			let resolutions = 0;
			const guard = await startNetGuard({
				resolve: async () => {
					resolutions++;
					return ["::1", "127.0.0.1"];
				},
				egress: (address) => address === "::1" || address === "127.0.0.1",
			});
			try {
				const proxyPort = Number(new URL(guard.url).port);
				const status =
					protocol === "http"
						? await new Promise<number>((ok, fail) => {
								http
									.get(
										{
											host: "127.0.0.1",
											port: proxyPort,
											path: `http://dualstack.example:${port}/`,
										},
										(r) => {
											r.resume();
											ok(r.statusCode ?? 0);
										},
									)
									.on("error", fail);
							})
						: await new Promise<number>((ok, fail) => {
								const c = net.connect(proxyPort, "127.0.0.1", () =>
									c.write(`CONNECT dualstack.example:${port} HTTP/1.1\r\n\r\n`),
								);
								c.on("error", fail);
								c.on("data", (data) => {
									ok(Number(String(data).split(" ")[1]));
									c.destroy();
								});
							});
				expect(status).toBe(200);
				expect(resolutions).toBe(1);
				expect(guard.blocked).toEqual([]);
			} finally {
				target.closeAllConnections();
				target.close();
				await guard.close();
			}
		},
	);
	test("CONNECT and plain HTTP to a private resolution are refused before connecting", async () => {
		let hits = 0;
		const target = http.createServer((_q, r) => {
			hits++;
			r.end("secret");
		});
		await new Promise<void>((ok) => target.listen(0, "127.0.0.1", ok));
		const port = (target.address() as net.AddressInfo).port;
		const guard = await startNetGuard({ resolve: async () => ["127.0.0.1"] });
		const proxyPort = Number(new URL(guard.url).port);
		const status = await new Promise<number>((ok) => {
			http.get(
				{
					host: "127.0.0.1",
					port: proxyPort,
					path: `http://rebind.example:${port}/`,
				},
				(r) => {
					r.resume();
					ok(r.statusCode ?? 0);
				},
			);
		});
		expect(status).toBe(403);
		const line = await new Promise<string>((ok) => {
			const c = net.connect(proxyPort, "127.0.0.1", () =>
				c.write(`CONNECT rebind.example:${port} HTTP/1.1\r\n\r\n`),
			);
			c.on("data", (d) => {
				ok(String(d).split("\r\n")[0]!);
				c.destroy();
			});
		});
		expect(line).toContain("403");
		expect(hits).toBe(0);
		expect(guard.blocked.map((b) => b.code)).toEqual([
			"navigation_private_resolved",
			"navigation_private_resolved",
		]);
		await guard.close();
		target.close();
	});
});

describe("egress range", () => {
	test("a declared fake-IP egress range is let through only for resolved names", async () => {
		const egress = cidrMatcher("198.18.0.0/15");
		expect(egress("198.19.255.1")).toBe(true);
		expect(egress("198.20.0.1")).toBe(false);
		const r = async () => ["198.18.0.1"];
		expect(await resolvePublic("example.com", r, egress)).toEqual({
			ok: true,
			address: "198.18.0.1",
		});
		expect(await resolvePublic("example.com", r, () => false)).toMatchObject({
			ok: false,
		});
		expect(await resolvePublic("198.18.0.1", r, egress)).toMatchObject({
			ok: false,
		});
		expect(await resolvePublic("127.0.0.1.nip.io", r, egress)).toMatchObject({
			ok: false,
		});
		expect(
			await resolvePublic(
				"x.example",
				async () => ["198.18.0.1", "10.0.0.1"],
				egress,
			),
		).toMatchObject({ ok: false });
	});
});
