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
import {
	cidrMatcher,
	isPrivateAddress,
	isPrivateHost,
} from "eumenes-interact/parts";

// The address rules live in the package (design R08); re-exported for the lab's callers and tests.
export { cidrMatcher, isPrivateAddress };

export type GuardBlock = { host: string; code: string; at: string };

export type Resolve = (host: string) => Promise<string[]>;

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
