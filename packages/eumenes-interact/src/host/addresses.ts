/**
 * Which hosts and addresses are not public (review 2026-11-04 H1/H2; design R08): pure functions a host's URL
 * policy and network guard both use, moved here from the lab so every host decides the same way. Literal
 * addresses and names only; no DNS is asked. Starting a proxy, resolving names and connecting stay with the
 * host. Ported from Eumenes' `navigation.ts` (commit 98b188d2).
 */

/** Dotted IPv4 octets of a host (the URL parser has turned `0x7f.1` and `2130706433` into this form). */
function ipv4Octets(host: string) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	return m ? m.slice(1).map(Number) : null;
}

export function privateIpv4([a, b]: number[]) {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b! >= 64 && b! <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b! >= 16 && b! <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a! >= 224
	);
}

const LOOPBACK_DNS = [
	"nip.io",
	"sslip.io",
	"xip.io",
	"traefik.me",
	"localtest.me",
	"lvh.me",
	"vcap.me",
	"localhost.direct",
];

const PRIVATE_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".lan",
	".home.arpa",
	".localdomain",
];

/**
 * Loopback, private and link-local hosts, including names that only resolve on a local network. Ported from
 * Eumenes' `navigation.ts` (commit 98b188d2). Literal addresses and names only: no DNS is asked.
 */
export function isPrivateHost(hostname: string) {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (host.includes(":")) {
		// Only global unicast (2000::/3) is public; mapped, loopback, unique-local and link-local are not.
		const first = Number.parseInt(host.split(":")[0] || "0", 16);
		return !(first >= 0x2000 && first <= 0x3fff);
	}
	const v4 = ipv4Octets(host);
	if (v4) return privateIpv4(v4);
	if (host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s)))
		return true;
	// Public wildcard-DNS names that resolve to an address written in the name (127.0.0.1.nip.io) or always to
	// loopback (lvh.me): no DNS is resolved here, so these are refused by name. Any other name that resolves to
	// a private address is not caught (a known limit, review 2026-11-04).
	if (LOOPBACK_DNS.some((d) => host === d || host.endsWith(`.${d}`)))
		return true;
	// A one-label name resolves through the local network's search domain.
	return !host.includes(".");
}

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
