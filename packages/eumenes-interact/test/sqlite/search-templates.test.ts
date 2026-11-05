import { test, expect } from "bun:test";
import { openLabDb, write } from "../../../../lab/host/db.ts";
import {
	getSearchUrl,
	putSearchTemplate,
	forgetSiteScope,
} from "../../src/sqlite.ts";
const entry = {
	origin: "https://example.org",
	pathPrefix: "/",
	template: "https://example.org/search?q={q}",
	revision: 1,
	sourceRef: "synthetic-spec@1",
	checkedAt: "2026-11-01T00:00:00.000Z",
	expiresAt: "2026-12-01T00:00:00.000Z",
};
test("URL hints have owner/origin/revision/expiry boundaries and query values remain encoded data", () => {
	const db = openLabDb(":memory:");
	try {
		write(db, () => putSearchTemplate(db, "a", entry));
		write(db, () => putSearchTemplate(db, "a", entry));
		expect(() =>
			write(db, () =>
				putSearchTemplate(db, "a", {
					...entry,
					template: "https://example.org/other?q={q}",
				}),
			),
		).toThrow("revision_conflict");
		expect(
			getSearchUrl(db, "a", "file:///tmp/test", "x", entry.checkedAt),
		).toBeNull();
		expect(
			getSearchUrl(db, "b", "https://example.org/", "x", entry.checkedAt),
		).toBeNull();
		expect(
			getSearchUrl(db, "a", "https://other.example/", "x", entry.checkedAt),
		).toBeNull();
		expect(
			getSearchUrl(db, "a", "https://example.org/", "x", entry.expiresAt),
		).toBeNull();
		expect(
			getSearchUrl(
				db,
				"a",
				"https://example.org/",
				"海 & token=x",
				entry.checkedAt,
			),
		).toBe(
			`https://example.org/search?q=${encodeURIComponent("海 & token=x")}`,
		);
		write(db, () =>
			putSearchTemplate(db, "a", {
				...entry,
				revision: 2,
				template: "https://example.org/new?q={q}",
			}),
		);
		write(db, () => putSearchTemplate(db, "a", entry));
		expect(
			getSearchUrl(db, "a", "https://example.org/", "x", entry.checkedAt),
		).toContain("/new?");
		expect(() =>
			write(db, () =>
				putSearchTemplate(db, "a", {
					...entry,
					template: "https://attacker.example/search?q={q}",
				}),
			),
		).toThrow();
		write(db, () => forgetSiteScope(db, "a", entry.origin));
		expect(
			getSearchUrl(db, "a", "https://example.org/", "x", entry.checkedAt),
		).toBeNull();
	} finally {
		db.close();
	}
});
