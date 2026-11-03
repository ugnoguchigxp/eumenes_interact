import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findSiteObjects,
	getSiteObject,
	listEvidence,
	listPageProfiles,
	type CandidateRecord,
} from "eumenes-interact/sqlite";
import {
	loadSeeds,
	importSeed,
	listKnowledge,
	readSeed,
	seedSchema,
	type Seed,
} from "../../knowledge/seed.ts";
import {
	lookupObject,
	profileChain,
	resolveCandidate,
	resolveObject,
} from "../../host/candidates.ts";
import { LAB_OWNER } from "../../host/run.ts";
import { freshDb } from "./harness.ts";

const NOW = "2026-11-03T00:00:00.000Z";
const KNOWLEDGE = join(import.meta.dir, "../../knowledge");

const cand = (
	kind: string,
	fields: Record<string, string | number | boolean>,
): Pick<CandidateRecord, "kind" | "fields"> => ({
	kind: kind as CandidateRecord["kind"],
	fields,
});

/** A results page in the shape of a snapshot: unnamed and named links, a main region, a footer. */
const PAGE = [
	"- banner [ref=e1]:",
	'  - searchbox "Wikipedia内を検索" [ref=e2]',
	'  - link "ホーム" [ref=e3]:',
	"    - /url: /wiki/Main",
	"- main [ref=e4]:",
	'  - link "ヘルプ" [ref=e5]:',
	"    - /url: /wiki/Help:%E6%A4%9C%E7%B4%A2",
	'  - link "特別" [ref=e6]:',
	"    - /url: /wiki/%E7%89%B9%E5%88%A5:%E6%A4%9C%E7%B4%A2",
	"  - link [ref=e7]:",
	"    - /url: /wiki/Thumb",
	'  - link "機械学習" [ref=e8]:',
	"    - /url: /wiki/%E6%A9%9F",
	'  - link "人工知能" [ref=e9]:',
	"    - /url: /wiki/AI",
	"- contentinfo [ref=e10]:",
	'  - link "規約" [ref=e11]:',
	"    - /url: /wiki/Terms",
].join("\n");

const refOf = (body: string, c: ReturnType<typeof cand>) => {
	const r = resolveCandidate(body, c);
	return r.kind === "found" ? r.match.ref : r.kind;
};

describe("resolving a candidate against the observation", () => {
	test("role with an exact name", () => {
		expect(
			refOf(
				PAGE,
				cand("role", { role: "searchbox", name: "Wikipedia内を検索" }),
			),
		).toBe("e2");
		expect(
			refOf(PAGE, cand("role", { role: "searchbox", name: "別の名前" })),
		).toBe("none");
		expect(
			refOf(PAGE, cand("role", { role: "textbox", name: "Wikipedia内を検索" })),
		).toBe("none");
		expect(refOf(PAGE, cand("role", { role: "main" }))).toBe("e4");
	});

	test("nameAnyOf is a|b of exact names, in either language", () => {
		const c = cand("role", { role: "searchbox", nameAnyOf: "検索|Search" });
		expect(refOf('- searchbox "検索" [ref=e1]', c)).toBe("e1");
		expect(refOf('- searchbox "Search" [ref=e2]', c)).toBe("e2");
		expect(refOf('- searchbox "Search box" [ref=e2]', c)).toBe("none");
		expect(
			refOf('- searchbox "検索" [ref=e1]\n- searchbox "Search" [ref=e2]', c),
		).toBe("ambiguous");
	});

	test("named: an unnamed element does not count", () => {
		const links = cand("structure", {
			role: "link",
			withinRole: "main",
			named: "true",
			urlIncludes: "/wiki/Thumb",
		});
		expect(refOf(PAGE, links)).toBe("none");
		expect(
			refOf(
				PAGE,
				cand("structure", {
					role: "link",
					withinRole: "main",
					urlIncludes: "/wiki/Thumb",
				}),
			),
		).toBe("e7");
		expect(
			refOf(
				PAGE,
				cand("structure", {
					role: "link",
					withinRole: "main",
					named: true,
					urlIncludes: "/wiki/Thumb",
				}),
			),
		).toBe("none");
	});

	test("urlIncludes and urlExcludes, also against the decoded address", () => {
		const base = {
			role: "link",
			withinRole: "main",
			named: "true",
			urlIncludes: "/wiki/",
		};
		expect(
			refOf(
				PAGE,
				cand("structure", {
					...base,
					urlExcludes: "/wiki/Help:|/wiki/特別:",
					nth: 0,
				}),
			),
		).toBe("e8");
		// Without the exclusion the help link is the first match.
		expect(refOf(PAGE, cand("structure", { ...base, nth: 0 }))).toBe("e5");
		expect(
			refOf(PAGE, cand("structure", { ...base, urlIncludes: "/nowhere/" })),
		).toBe("none");
		// The decoded form is what the exclusion names.
		expect(
			refOf(
				PAGE,
				cand("structure", { ...base, urlIncludes: "特別:", urlExcludes: "x" }),
			),
		).toBe("e6");
	});

	test("withinRole is an ancestor by indentation", () => {
		const inMain = cand("structure", {
			role: "link",
			withinRole: "main",
			urlIncludes: "/wiki/AI",
		});
		expect(refOf(PAGE, inMain)).toBe("e9");
		expect(
			refOf(
				PAGE,
				cand("structure", {
					role: "link",
					withinRole: "banner",
					urlIncludes: "/wiki/AI",
				}),
			),
		).toBe("none");
		expect(
			refOf(
				PAGE,
				cand("structure", {
					role: "link",
					withinRole: "contentinfo",
					urlIncludes: "/wiki/",
				}),
			),
		).toBe("e11");
	});

	test("one match is found, several are ambiguous, and nth is the explicit choice", () => {
		const links = { role: "link", withinRole: "main", named: "true" };
		expect(refOf(PAGE, cand("structure", links))).toBe("ambiguous");
		expect(refOf(PAGE, cand("structure", { ...links, nth: 0 }))).toBe("e5");
		expect(refOf(PAGE, cand("structure", { ...links, nth: "3" }))).toBe("e9");
		expect(refOf(PAGE, cand("structure", { ...links, nth: 4 }))).toBe("none");
	});

	test("unsupported kinds and malformed fields are never guessed at", () => {
		expect(refOf(PAGE, cand("test_id", { id: "x" }))).toBe("unsupported");
		expect(refOf(PAGE, cand("structure", { name: "x" }))).toBe("unsupported");
		expect(refOf(PAGE, cand("structure", { role: "link", nth: -1 }))).toBe(
			"unsupported",
		);
		expect(refOf(PAGE, cand("structure", { role: "link", nth: "x" }))).toBe(
			"unsupported",
		);
	});

	test("an element without a ref is not a target", () => {
		expect(
			refOf('- searchbox "検索"', cand("role", { role: "searchbox" })),
		).toBe("none");
	});

	test("the match carries the page's own name for the element", () => {
		expect(resolveCandidate(PAGE, cand("role", { role: "searchbox" }))).toEqual(
			{
				kind: "found",
				match: { ref: "e2", role: "searchbox", name: "Wikipedia内を検索" },
			},
		);
	});
});

describe("an object's candidates", () => {
	const record = (
		id: number,
		status: CandidateRecord["status"],
		fields: Record<string, string | number | boolean>,
	): CandidateRecord => ({
		id,
		objectId: 1,
		kind: "role",
		fields,
		status,
		statusReason: null,
		statusChangedAt: NOW,
		source: { adapter: "playwright-mcp", via: "snapshot" },
		addedRevision: 1,
		createdAt: NOW,
	});

	test("candidates are a set that must agree on one element; stale and disabled ones are not tried", () => {
		const a = record(1, "candidate", { role: "searchbox" });
		const b = record(2, "verified", {
			role: "searchbox",
			name: "Wikipedia内を検索",
		});
		expect(resolveObject(PAGE, [a, b])).toMatchObject({
			kind: "found",
			candidateIds: [1, 2],
		});
		const elsewhere = record(3, "candidate", { role: "main" });
		expect(resolveObject(PAGE, [a, elsewhere])).toEqual({ kind: "ambiguous" });
		const stale = record(4, "stale", { role: "main" });
		const disabled = record(5, "disabled", { role: "main" });
		expect(resolveObject(PAGE, [a, stale, disabled])).toMatchObject({
			kind: "found",
			candidateIds: [1],
		});
		expect(resolveObject(PAGE, [stale, disabled])).toEqual({ kind: "none" });
		expect(
			resolveObject(PAGE, [record(6, "candidate", { role: "nothing" })]),
		).toEqual({ kind: "none" });
	});
});

describe("page profiles", () => {
	const profile = (name: string, urlHint: string | null) => ({
		id: 1,
		scopeId: 1,
		name,
		description: null,
		urlHint,
		conditions: {},
		basis: null,
		createdAt: NOW,
		updatedAt: NOW,
	});
	const profiles = [
		profile("any", "/"),
		profile("article", "/wiki/"),
		profile("results", "/w/index.php"),
		profile("deep", "/wiki/Special:"),
		profile("hintless", null),
	];
	const names = (url: string) => profileChain(profiles, url).map((p) => p.name);

	test("the longest matching prefix wins and `/` is the fallback", () => {
		expect(names("https://ja.wikipedia.org/wiki/Foo")).toEqual([
			"article",
			"any",
		]);
		expect(names("https://ja.wikipedia.org/wiki/Special:Search?q=1#x")).toEqual(
			["deep", "article", "any"],
		);
		expect(names("https://ja.wikipedia.org/w/index.php?search=x")).toEqual([
			"results",
			"any",
		]);
		expect(names("https://ja.wikipedia.org/")).toEqual(["any"]);
		expect(names("https://ja.wikipedia.org/wikipedia")).toEqual(["any"]);
		expect(names("not a url")).toEqual([]);
	});
});

describe("knowledge of a site", () => {
	const wikipedia = async () => readSeed(join(KNOWLEDGE, "wikipedia.json"));

	test("an object of `/` is known on every page; one of a kind of page only there", async () => {
		const db = freshDb();
		importSeed(db, LAB_OWNER, await wikipedia(), NOW);
		const at = (path: string, name: string) =>
			lookupObject(db, LAB_OWNER, `https://ja.wikipedia.org${path}`, name);
		expect(at("/wiki/Foo", "search.query")).toMatchObject({
			kind: "defined",
			profile: "any",
		});
		expect(at("/wiki/Foo", "article.body")).toMatchObject({
			kind: "defined",
			profile: "article",
		});
		expect(at("/w/index.php?search=x", "search.first_result")).toMatchObject({
			kind: "defined",
			profile: "search_results",
		});
		// Defined for results pages only: not on an article, not on the top page.
		expect(at("/wiki/Foo", "search.first_result")).toEqual({
			kind: "undefined",
			profile: "article",
		});
		expect(at("/", "search.first_result")).toEqual({
			kind: "undefined",
			profile: "any",
		});
		expect(at("/wiki/Foo", "nothing.at_all")).toEqual({
			kind: "undefined",
			profile: "article",
		});
		// A site with no knowledge, or another origin of it, knows nothing.
		expect(
			lookupObject(
				db,
				LAB_OWNER,
				"https://en.wikipedia.org/wiki/Foo",
				"search.query",
			),
		).toEqual({
			kind: "undefined",
			profile: null,
		});
		expect(lookupObject(db, LAB_OWNER, "garbage", "search.query")).toEqual({
			kind: "undefined",
			profile: null,
		});
	});
});

describe("importing seeds", () => {
	test("every seed in lab/knowledge is valid and imports", async () => {
		const seeds = await loadSeeds();
		expect(seeds.map((s) => s.file)).toEqual([
			"biggo.json",
			"gizmodo.json",
			"slashdot.json",
			"wikipedia.json",
		]);
		const db = freshDb();
		for (const { seed } of seeds) importSeed(db, LAB_OWNER, seed, NOW);
		expect(listKnowledge(db, LAB_OWNER).map((k) => k.origin)).toEqual([
			"https://biggo.jp",
			"https://ja.wikipedia.org",
			"https://slashdot.org",
			"https://www.gizmodo.jp",
		]);
	});

	test("importing twice changes nothing: same rows, same revisions, candidates stay candidates", async () => {
		const db = freshDb();
		const seed = await readSeed(join(KNOWLEDGE, "wikipedia.json"));
		const first = importSeed(db, LAB_OWNER, seed, NOW);
		expect(first).toEqual([
			{
				origin: "https://ja.wikipedia.org",
				profiles: 3,
				created: 3,
				revised: 0,
				unchanged: 0,
			},
		]);
		const before = JSON.stringify(listKnowledge(db, LAB_OWNER));
		const rows = () =>
			db
				.query(
					"SELECT (SELECT COUNT(*) FROM interact_locator_candidates) AS c, (SELECT COUNT(*) FROM interact_site_objects) AS o, (SELECT COUNT(*) FROM interact_page_profiles) AS p",
				)
				.get();
		const counts = rows();
		const second = importSeed(db, LAB_OWNER, seed, "2026-11-04T00:00:00.000Z");
		expect(second).toEqual([
			{
				origin: "https://ja.wikipedia.org",
				profiles: 3,
				created: 0,
				revised: 0,
				unchanged: 3,
			},
		]);
		expect(JSON.stringify(listKnowledge(db, LAB_OWNER))).toBe(before);
		expect(rows()).toEqual(counts);
		const objects = findSiteObjects(db, LAB_OWNER, {
			origin: "https://ja.wikipedia.org",
		});
		expect(objects.every((o) => o.revision === 1)).toBe(true);
		expect(
			objects
				.flatMap((o) => o.candidates)
				.every((c) => c.status === "candidate"),
		).toBe(true);
	});

	test("a changed seed revises the object with the expected revision and disables what it dropped", async () => {
		const db = freshDb();
		const seed = await readSeed(join(KNOWLEDGE, "wikipedia.json"));
		importSeed(db, LAB_OWNER, seed, NOW);
		const changed: Seed = structuredClone(seed);
		const target = changed.objects.find(
			(o) => o.logicalName === "search.first_result",
		)!;
		target.candidates[0]!.fields = { ...target.candidates[0]!.fields, nth: 1 };
		const report = importSeed(db, LAB_OWNER, changed, NOW);
		expect(report[0]).toMatchObject({ created: 0, revised: 1, unchanged: 2 });
		const [object] = findSiteObjects(db, LAB_OWNER, {
			origin: "https://ja.wikipedia.org",
			logicalName: "search.first_result",
			includeDisabled: true,
		});
		expect(object?.revision).toBe(2);
		expect(
			object?.candidates.map((c) => [c.status, c.statusReason, c.fields.nth]),
		).toEqual([
			["disabled", "seed_changed", 0],
			["candidate", null, 1],
		]);
		// The resolver only tries the live one.
		expect(resolveObject('- link "x" [ref=e1]', object!.candidates)).toEqual({
			kind: "none",
		});
		// A description change revises too; going back brings the old candidate back.
		const described: Seed = structuredClone(changed);
		described.objects.find(
			(o) => o.logicalName === "search.first_result",
		)!.description = "別の説明";
		expect(importSeed(db, LAB_OWNER, described, NOW)[0]).toMatchObject({
			revised: 1,
		});
		expect(importSeed(db, LAB_OWNER, seed, NOW)[0]).toMatchObject({
			revised: 1,
			unchanged: 2,
		});
		const [back] = findSiteObjects(db, LAB_OWNER, {
			origin: "https://ja.wikipedia.org",
			logicalName: "search.first_result",
			includeDisabled: true,
		});
		expect(back?.revision).toBe(4);
		expect(
			back?.candidates
				.filter((c) => c.status === "candidate")
				.map((c) => c.fields.nth),
		).toEqual([0]);
		expect(importSeed(db, LAB_OWNER, seed, NOW)[0]).toMatchObject({
			unchanged: 3,
		});
	});

	test("a profile that changed is updated; one that did not is left alone", async () => {
		const db = freshDb();
		const seed = await readSeed(join(KNOWLEDGE, "wikipedia.json"));
		importSeed(db, LAB_OWNER, seed, NOW);
		const changed: Seed = structuredClone(seed);
		changed.pageProfiles[1]!.urlHint = "/w/";
		importSeed(db, LAB_OWNER, changed, "2026-11-04T00:00:00.000Z");
		const profiles = listPageProfiles(
			db,
			LAB_OWNER,
			"https://ja.wikipedia.org",
		);
		expect(
			profiles.map((p) => [p.name, p.urlHint, p.updatedAt.slice(0, 10)]),
		).toEqual([
			["any", "/", "2026-11-03"],
			["article", "/wiki/", "2026-11-03"],
			["search_results", "/w/", "2026-11-04"],
		]);
	});

	test("several origins share one seed: the same profiles and objects for each scope", async () => {
		const db = freshDb();
		const seed: Seed = {
			...(await readSeed(join(KNOWLEDGE, "wikipedia.json"))),
			origins: ["https://ja.wikipedia.org", "https://en.wikipedia.org"],
		};
		expect(
			importSeed(db, LAB_OWNER, seed, NOW).map((r) => [r.origin, r.created]),
		).toEqual([
			["https://ja.wikipedia.org", 3],
			["https://en.wikipedia.org", 3],
		]);
		const listing = listKnowledge(db, LAB_OWNER);
		expect(listing.map((l) => l.origin)).toEqual([
			"https://en.wikipedia.org",
			"https://ja.wikipedia.org",
		]);
		expect(JSON.stringify(listing[0]!.objects)).toBe(
			JSON.stringify(listing[1]!.objects),
		);
		expect(
			listKnowledge(db, LAB_OWNER, "https://en.wikipedia.org"),
		).toHaveLength(1);
		expect(listKnowledge(db, LAB_OWNER, "https://nope.example")).toEqual([]);
		const stranger = findSiteObjects(db, "someone-else", {
			origin: "https://ja.wikipedia.org",
		});
		expect(stranger).toEqual([]);
	});

	test("a seed with a candidate no resolver reads, an unknown profile or a secret-looking field is refused", async () => {
		const seed = await readSeed(join(KNOWLEDGE, "wikipedia.json"));
		const bad = (change: (s: Seed) => void) => {
			const s: Seed = structuredClone(seed);
			change(s);
			return seedSchema.safeParse(s).success;
		};
		expect(bad(() => {})).toBe(true);
		expect(bad((s) => (s.objects[0]!.profile = "nope"))).toBe(false);
		expect(bad((s) => s.objects.push(structuredClone(s.objects[0]!)))).toBe(
			false,
		);
		expect(
			bad(
				(s) =>
					(s.objects[0]!.candidates[0]!.fields = { role: "x", tag: "input" }),
			),
		).toBe(false);
		expect(
			bad((s) => (s.objects[0]!.candidates[0]!.fields = { name: "x" })),
		).toBe(false);
		expect(
			bad(
				(s) =>
					(s.objects[0]!.candidates[0]!.fields = {
						role: "x",
						name: "a",
						nameAnyOf: "b|c",
					}),
			),
		).toBe(false);
		expect(
			bad((s) => (s.objects[0]!.candidates[0]!.kind = "label" as never)),
		).toBe(false);
		expect(bad((s) => (s.pageProfiles[0]!.urlHint = "/a?q=1"))).toBe(false);
		expect(bad((s) => (s.origins = ["http://ja.wikipedia.org"]))).toBe(false);
		expect(bad((s) => (s.origins = []))).toBe(false);
	});

	test("an invalid seed file is an error that names the file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "interact-seed-test-"));
		try {
			writeFileSync(join(dir, "bad.json"), JSON.stringify({ origins: [] }));
			await expect(readSeed(join(dir, "bad.json"))).rejects.toThrow(
				/invalid_seed:.*bad\.json/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("evidence can be read back for an object", async () => {
		const db = freshDb();
		importSeed(
			db,
			LAB_OWNER,
			await readSeed(join(KNOWLEDGE, "wikipedia.json")),
			NOW,
		);
		const [object] = findSiteObjects(db, LAB_OWNER, {
			origin: "https://ja.wikipedia.org",
			logicalName: "search.query",
		});
		expect(getSiteObject(db, LAB_OWNER, object!.id)?.candidates).toHaveLength(
			1,
		);
		expect(listEvidence(db, LAB_OWNER, object!.id)).toEqual([]);
	});
});
