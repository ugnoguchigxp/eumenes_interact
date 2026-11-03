import { realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { FIXTURES_DIR } from "../cases/load.ts";

/**
 * Serves `lab/fixtures/` over loopback HTTP for the duration of a run. Static files only: GET and HEAD, no
 * directory listing, no traversal, no symlink out of the root, correct content types, no caching.
 * `createFixtureHandler` is pure request handling (unit-tested without a socket); only `startFixtureServer`
 * binds a port, and only a real CLI run calls it.
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
};

const HEADERS = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
};

const reply = (status: number, extra: Record<string, string> = {}) =>
	new Response(null, { status, headers: { ...HEADERS, ...extra } });

export function createFixtureHandler(
	root: string = FIXTURES_DIR,
): (request: Request) => Promise<Response> {
	let realRoot: Promise<string> | undefined;
	return async (request) => {
		if (request.method !== "GET" && request.method !== "HEAD")
			return reply(405, { allow: "GET, HEAD" });
		let path: string;
		try {
			path = decodeURIComponent(new URL(request.url).pathname);
		} catch {
			return reply(400);
		}
		// Segments are checked before the file system is asked anything.
		const segments = path.split("/").slice(1);
		if (
			path.includes("\0") ||
			path.includes("\\") ||
			segments.some((s) => s === ".." || s === ".") ||
			segments.at(-1) === ""
		)
			return reply(path.endsWith("/") ? 404 : 400);
		try {
			realRoot ??= realpath(root);
			const base = await realRoot;
			// A symlink is followed here, so one that leaves the root is caught by the prefix check.
			const file = await realpath(join(base, ...segments));
			if (!file.startsWith(base + sep)) return reply(404);
			if (!(await stat(file)).isFile()) return reply(404);
			const headers = {
				...HEADERS,
				"content-type":
					CONTENT_TYPES[extname(file).toLowerCase()] ??
					"application/octet-stream",
			};
			return request.method === "HEAD"
				? new Response(null, { headers })
				: new Response(Bun.file(file), { headers });
		} catch {
			return reply(404);
		}
	};
}

export type FixtureServer = { baseUrl: string; stop(): void };

/** Binds `127.0.0.1` on an ephemeral port. `baseUrl` ends with `/`. */
export function startFixtureServer(root: string = FIXTURES_DIR): FixtureServer {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: createFixtureHandler(root),
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/`,
		stop: () => void server.stop(true),
	};
}
