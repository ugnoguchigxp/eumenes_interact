/**
 * The network guard of a live session (review 2026-11-04 H1/H2): a loopback HTTP proxy the browser is started
 * behind (`--proxy-server`), so every request the browser makes, not only the URLs the host opens, passes one
 * check: navigations, each redirect hop, subresources, iframes, workers and downloads. The guard resolves the
 * name itself and connects to the address it checked, so a name that resolves (or re-resolves, DNS rebinding)
 * to a loopback, private, link-local or unique-local address is refused before any byte reaches it. It does not
 * apply the run's origin scope: pages load subresources from other origins, and scope stays with the host's
 * navigation policy. Requests are refused, never rewritten; HTTPS is tunnelled, never decrypted.
 */

import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { isPrivateHost, privateIpv4 } from "./policy.ts";

export type GuardBlock = { host: string; code: string; at: string };

/** Expands an IPv6 literal to eight 16-bit groups; `null` if it is not one. */
function ipv6Groups(raw: string): number[] | null {
	let host = raw.replace(/^\[|\]$/g, "").toLowerCase();
	const zone = host.indexOf("%");
	if (zone >= 0) host = host.slice(0, zone);
	if (!host.includes(":")) return null;
	const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) {
		const o = v4.slice(1).map(Number);
		if (o.some((n) => n > 255)) return null;
		host = `${host.slice(0, v4.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
	}
	const halves = host.split("::");
	if (halves.length > 2) return null;
	const part = (s: string) =>
		s === ""
			? []
			: s
					.split(":")
					.map((g) =>
						/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
					);
	const head = part(halves[0]!);
	const rest = halves.length === 2 ? part(halves[1]!) : [];
	const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
	if (fill < 0) return null;
	const groups = [...head, ...Array(fill).fill(0), ...rest];
	if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
	return groups;
}

/** Whether a literal address (IPv4 or IPv6) is anything but public unicast. */
export function isPrivateAddress(address: string): boolean {
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
	if (v4) return privateIpv4(v4.slice(1).map(Number));
	const g = ipv6Groups(address);
	if (!g) return true;
	const embedded = (hi: number, lo: number) =>
		privateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
	// ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::/96 (NAT64): the IPv4 inside decides.
	if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0))
		return g[5] === 0 && g[6] === 0 ? true : embedded(g[6]!, g[7]!);
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
		return embedded(g[6]!, g[7]!);
	// 6to4 (2002::/16) carries an IPv4 in groups 1-2.
	if (g[0] === 0x2002) return embedded(g[1]!, g[2]!);
	// Only global unicast 2000::/3 is public (ULA fc00::/7, link-local fe80::/10, multicast ff00::/8 are not).
	return !(g[0]! >= 0x2000 && g[0]! <= 0x3fff);
}

export type Resolve = (host: string) => Promise<string[]>;

/** IPv4 CIDR list (`198.18.0.0/15,10.0.0.0/8`) as a membership test; malformed entries are ignored. */
export function cidrMatcher(list: string): (address: string) => boolean {
	const nets = list
		.split(",")
		.map((e) =>
			/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(e.trim()),
		)
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => {
			const bits = Number(m[5]);
			const base = m.slice(1, 5).reduce((a, o) => a * 256 + Number(o), 0);
			const size = 2 ** (32 - bits);
			return { start: base - (base % size), size };
		});
	return (address) => {
		const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
		if (!m) return false;
		const n = m.slice(1).reduce((a, o) => a * 256 + Number(o), 0);
		return nets.some((x) => n >= x.start && n < x.start + x.size);
	};
}

/**
 * Some sandboxes answer every name with one fake address of their egress (a "fake-IP" resolver, e.g. every
 * name -> 198.18.0.1) and resolve the real name on the far side. Such an answer says nothing about the real
 * destination, so a run in such a sandbox must declare the range (`LAB_NET_GUARD_EGRESS=198.18.0.0/15`):
 * resolutions into it are let through to the egress, which does the real resolution on its own network. Name
 * rules still apply; a literal address in the range is still refused. Without the variable nothing is exempt.
 */
export const envEgress = cidrMatcher(process.env.LAB_NET_GUARD_EGRESS ?? "");
const systemResolve: Resolve = async (host) =>
	(await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The address to connect to for `host`, or a refusal code. A literal is checked as is; a name is refused by
 * name first (`isPrivateHost`) and then resolved: every address must be public, and the first is used.
 */
export async function resolvePublic(
	hostname: string,
	resolve: Resolve = systemResolve,
	egress: (address: string) => boolean = envEgress,
): Promise<{ ok: true; address: string } | { ok: false; code: string }> {
	const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (net.isIP(host))
		return isPrivateAddress(host)
			? { ok: false, code: "navigation_private_blocked" }
			: { ok: true, address: host };
	if (isPrivateHost(host))
		return { ok: false, code: "navigation_private_blocked" };
	let addresses: string[];
	try {
		addresses = await resolve(host);
	} catch {
		return { ok: false, code: "navigation_dns_failed" };
	}
	if (addresses.length === 0)
		return { ok: false, code: "navigation_dns_failed" };
	if (addresses.some((a) => isPrivateAddress(a) && !egress(a)))
		return { ok: false, code: "navigation_private_resolved" };
	return { ok: true, address: addresses[0]! };
}

const HOP_HEADERS = [
	"proxy-connection",
	"proxy-authorization",
	"connection",
	"keep-alive",
	"te",
	"trailer",
	"upgrade",
];

export type NetGuard = {
	/** `http://127.0.0.1:<port>` for `--proxy-server`. */
	url: string;
	blocked: GuardBlock[];
	close(): Promise<void>;
};

export async function startNetGuard(
	options: {
		resolve?: Resolve;
		egress?: (address: string) => boolean;
		onBlock?: (b: GuardBlock) => void;
	} = {},
): Promise<NetGuard> {
	const blocked: GuardBlock[] = [];
	const block = (host: string, code: string) => {
		const b = { host, code, at: new Date().toISOString() };
		if (blocked.length < 200) blocked.push(b);
		options.onBlock?.(b);
	};
	const check = (host: string) =>
		resolvePublic(host, options.resolve, options.egress);
	const server = http.createServer(async (req, res) => {
		let url: URL;
		try {
			url = new URL(req.url ?? "");
		} catch {
			res.writeHead(400).end();
			return;
		}
		if (url.protocol !== "http:") {
			block(url.host, "navigation_scheme_blocked");
			res.writeHead(403).end();
			return;
		}
		const verdict = await check(url.hostname);
		if (!verdict.ok) {
			block(url.hostname, verdict.code);
			res
				.writeHead(403, { "content-type": "text/plain" })
				.end(`blocked: ${verdict.code}`);
			return;
		}
		const headers = { ...req.headers };
		for (const h of HOP_HEADERS) delete headers[h];
		const upstream = http.request(
			{
				host: verdict.address,
				port: url.port || 80,
				method: req.method,
				path: `${url.pathname}${url.search}`,
				headers: { ...headers, host: url.host },
				setHost: false,
			},
			(up) => {
				res.writeHead(up.statusCode ?? 502, up.headers);
				up.pipe(res);
			},
		);
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.pipe(upstream);
	});
	server.on(
		"connect",
		async (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
			client.on("error", () => {});
			const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(req.url ?? "");
			if (!m) {
				client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
				return;
			}
			const host = m[1]!;
			const port = Number(m[2]);
			const verdict = await check(host);
			if (!verdict.ok) {
				block(host, verdict.code);
				client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
				return;
			}
			const up = net.connect(port, verdict.address, () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) up.write(head);
				up.pipe(client);
				client.pipe(up);
			});
			up.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
			client.on("close", () => up.destroy());
		},
	);
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const port = (server.address() as net.AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		blocked,
		close: () =>
			new Promise<void>((ok) => {
				server.closeAllConnections?.();
				server.close(() => ok());
			}),
	};
}
