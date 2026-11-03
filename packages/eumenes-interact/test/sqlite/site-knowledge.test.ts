import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	addLocatorCandidate,
	findSiteObjects,
	getSiteObject,
	getSiteScope,
	listEvidence,
	listPageProfiles,
	markOperationDispatched,
	recordEvidence,
	recordOperationIntent,
	setCandidateStatus,
	upsertPageProfile,
	upsertSiteScope,
	writeSiteObject,
	type CandidateInput,
	type WriteSiteObjectInput,
} from "../../src/sqlite/index.ts";
import {
	LATER,
	NOW,
	OWNER_A,
	OWNER_B,
	count,
	dumpAllText,
	openTransaction,
	startedRun,
} from "./support.ts";

const ORIGIN_X = "https://search.example.org";
const ORIGIN_Y = "https://other.example.org";

const ROLE_CANDIDATE: CandidateInput = {
	kind: "role",
	fields: { role: "searchbox", name: "Search the site" },
	source: { adapter: "playwright-mcp", via: "snapshot" },
};
const ATTRIBUTE_CANDIDATE: CandidateInput = {
	kind: "attribute",
	fields: { tag: "input", name: "q" },
	source: { adapter: "playwright-mcp", via: "inspectLocator" },
};

function setup(db: Database, owner = OWNER_A, origin = ORIGIN_X) {
	upsertSiteScope(db, owner, origin, NOW);
	upsertPageProfile(db, owner, origin, { name: "home" }, NOW);
}

function write(
	db: Database,
	overrides: Partial<WriteSiteObjectInput> = {},
	owner = OWNER_A,
) {
	return writeSiteObject(db, owner, {
		origin: ORIGIN_X,
		profile: "home",
		logicalName: "search.query",
		expectedRevision: 0,
		nowIso: NOW,
		...overrides,
	});
}

describe("scopes and page profiles", () => {
	test("a scope is unique per owner and origin; upsert returns the same row", () => {
		const db = openTransaction();
		const first = upsertSiteScope(db, OWNER_A, ORIGIN_X, NOW);
		const again = upsertSiteScope(db, OWNER_A, ORIGIN_X, LATER);
		const other = upsertSiteScope(db, OWNER_B, ORIGIN_X, NOW);
		expect(again).toEqual(first);
		expect(other.id).not.toBe(first.id);
		expect(getSiteScope(db, OWNER_A, ORIGIN_Y)).toBeNull();
	});

	test("origins are validated by format", () => {
		const db = openTransaction();
		for (const bad of [
			"https://user:pw@a.example",
			"https://a.example/",
			"https://a.example/path",
			"https://a.example?q=1",
			"https://a.example#x",
			"https://A.example",
			"ftp://a.example",
			"a.example",
			"https://a.example:443",
			"http://a.example:80",
			"https://a.example:0",
			"https://a.example:65536",
			"https://a..example",
			"https://",
			"",
		]) {
			expect(() => upsertSiteScope(db, OWNER_A, bad, NOW)).toThrow(
				"invalid_origin",
			);
		}
		for (const good of [
			"https://a.example",
			"http://localhost:3000",
			"https://xn--bcher-kva.example",
			"http://[::1]:8080",
			"https://a.example:8443",
		]) {
			upsertSiteScope(db, OWNER_A, good, NOW);
		}
	});

	test("profiles need an existing scope, replace on upsert and are scoped", () => {
		const db = openTransaction();
		expect(() =>
			upsertPageProfile(db, OWNER_A, ORIGIN_X, { name: "home" }, NOW),
		).toThrow("not_found");
		setup(db);
		const profile = upsertPageProfile(
			db,
			OWNER_A,
			ORIGIN_X,
			{
				name: "home",
				description: "Landing page",
				urlHint: "/",
				conditions: { lang: "ja", signedIn: false },
				basis: "Has a search form",
			},
			LATER,
		);
		expect(profile).toMatchObject({
			name: "home",
			urlHint: "/",
			conditions: { lang: "ja", signedIn: false },
			createdAt: NOW,
			updatedAt: LATER,
		});
		expect(listPageProfiles(db, OWNER_A, ORIGIN_X)).toHaveLength(1);
		expect(listPageProfiles(db, OWNER_B, ORIGIN_X)).toEqual([]);
		expect(listPageProfiles(db, OWNER_A, ORIGIN_Y)).toEqual([]);
		expect(() =>
			upsertPageProfile(
				db,
				OWNER_A,
				ORIGIN_X,
				{ name: "x", urlHint: "/a?q=1" },
				NOW,
			),
		).toThrow("invalid_input");
		expect(() =>
			upsertPageProfile(
				db,
				OWNER_A,
				ORIGIN_X,
				{ name: "x", conditions: { authToken: "abc" } },
				NOW,
			),
		).toThrow("invalid_input");
	});
});

describe("site objects", () => {
	test("create, find and revise with candidates", () => {
		const db = openTransaction();
		setup(db);
		const created = write(db, {
			role: "searchbox",
			description: "Site search field",
			important: true,
			candidates: [ROLE_CANDIDATE, ATTRIBUTE_CANDIDATE],
		});
		expect(created).toMatchObject({
			origin: ORIGIN_X,
			profile: { name: "home" },
			logicalName: "search.query",
			revision: 1,
			important: true,
			role: "searchbox",
		});
		expect(
			created.candidates.map((c) => [c.kind, c.status, c.addedRevision]),
		).toEqual([
			["role", "candidate", 1],
			["attribute", "candidate", 1],
		]);
		expect(created.candidates[1]?.source).toEqual({
			adapter: "playwright-mcp",
			via: "inspectLocator",
		});

		const revised = write(db, {
			expectedRevision: 1,
			description: "Updated",
			candidates: [
				{
					kind: "label",
					fields: { label: "Search" },
					source: { adapter: "agent-browser", via: "get_attr" },
				},
			],
			nowIso: LATER,
		});
		expect(revised.revision).toBe(2);
		expect(revised.description).toBe("Updated");
		// Omitted fields keep their value.
		expect(revised.role).toBe("searchbox");
		expect(revised.important).toBe(true);
		expect(revised.candidates).toHaveLength(3);
		expect(revised.candidates[2]?.addedRevision).toBe(2);
		expect(findSiteObjects(db, OWNER_A, { origin: ORIGIN_X })).toEqual([
			revised,
		]);
	});

	test("a stale or wrong expected revision is a conflict and writes nothing", () => {
		const db = openTransaction();
		setup(db);
		write(db, { candidates: [ROLE_CANDIDATE] });
		write(db, { expectedRevision: 1, description: "second" });
		const before = dumpAllText(db);
		expect(() =>
			write(db, { expectedRevision: 1, candidates: [ATTRIBUTE_CANDIDATE] }),
		).toThrow("revision_conflict");
		// Creating something that exists is a conflict too.
		expect(() => write(db, { expectedRevision: 0 })).toThrow(
			"revision_conflict",
		);
		expect(() =>
			write(db, { logicalName: "other.thing", expectedRevision: 3 }),
		).toThrow("not_found");
		expect(dumpAllText(db)).toBe(before);
	});

	test("invalid parts reject the whole call before anything is written", () => {
		const db = openTransaction();
		setup(db);
		write(db, { candidates: [ROLE_CANDIDATE] });
		const before = dumpAllText(db);
		const bad: CandidateInput[] = [
			{ ...ATTRIBUTE_CANDIDATE, fields: { name: "q", password: "x" } },
			{ ...ATTRIBUTE_CANDIDATE, fields: { ref: "e12" } },
			{ ...ATTRIBUTE_CANDIDATE, fields: {} },
			{ ...ATTRIBUTE_CANDIDATE, fields: { href: "https://u:p@a.example/x" } },
			{ ...ATTRIBUTE_CANDIDATE, kind: "css" as "role" },
			{
				...ATTRIBUTE_CANDIDATE,
				source: { adapter: "playwright-mcp", via: "" },
			},
			{
				...ATTRIBUTE_CANDIDATE,
				source: undefined as unknown as CandidateInput["source"],
			},
			{
				...ATTRIBUTE_CANDIDATE,
				source: { adapter: "selenium" as "playwright-mcp", via: "x" },
			},
		];
		for (const candidate of bad) {
			expect(() =>
				write(db, {
					expectedRevision: 1,
					candidates: [ATTRIBUTE_CANDIDATE, candidate],
				}),
			).toThrow("invalid_input");
		}
		expect(dumpAllText(db)).toBe(before);
	});

	test("needs an existing profile of this owner and origin", () => {
		const db = openTransaction();
		setup(db);
		expect(() => write(db, { origin: ORIGIN_Y })).toThrow("not_found");
		expect(() => write(db, { profile: "missing" })).toThrow("not_found");
		expect(() => write(db, {}, OWNER_B)).toThrow("not_found");
	});

	test("the same logical name exists per profile and per origin, never resolved by name alone", () => {
		const db = openTransaction();
		setup(db);
		setup(db, OWNER_A, ORIGIN_Y);
		upsertPageProfile(db, OWNER_A, ORIGIN_X, { name: "results" }, NOW);
		write(db, { candidates: [ROLE_CANDIDATE] });
		write(db, { profile: "results", candidates: [ATTRIBUTE_CANDIDATE] });
		write(db, { origin: ORIGIN_Y, description: "other site" });

		const x = findSiteObjects(db, OWNER_A, {
			origin: ORIGIN_X,
			logicalName: "search.query",
		});
		expect(x.map((o) => o.profile.name)).toEqual(["home", "results"]);
		const y = findSiteObjects(db, OWNER_A, {
			origin: ORIGIN_Y,
			logicalName: "search.query",
		});
		expect(y).toHaveLength(1);
		expect(y[0]?.candidates).toEqual([]);
		expect(y[0]?.description).toBe("other site");
		// Origin X's candidates never appear under origin Y.
		const xHome = findSiteObjects(db, OWNER_A, {
			origin: ORIGIN_X,
			profile: "home",
			logicalName: "search.query",
		});
		expect(xHome).toHaveLength(1);
		expect(xHome[0]?.candidates.map((c) => c.kind)).toEqual(["role"]);
		expect(
			findSiteObjects(db, OWNER_A, { origin: "https://nothing.example.org" }),
		).toEqual([]);
		expect(() =>
			findSiteObjects(db, OWNER_A, { origin: "search.example.org" }),
		).toThrow("invalid_origin");
	});

	test("owner A never sees owner B's knowledge", () => {
		const db = openTransaction();
		setup(db, OWNER_A);
		setup(db, OWNER_B);
		const a = write(db, { description: "a", candidates: [ROLE_CANDIDATE] });
		const b = write(db, { description: "b" }, OWNER_B);
		expect(findSiteObjects(db, OWNER_A, { origin: ORIGIN_X })).toHaveLength(1);
		expect(
			findSiteObjects(db, OWNER_B, { origin: ORIGIN_X })[0]?.description,
		).toBe("b");
		expect(getSiteObject(db, OWNER_B, a.id)).toBeNull();
		expect(getSiteObject(db, OWNER_A, b.id)).toBeNull();
		// Ids of another owner answer as missing everywhere.
		expect(() => listEvidence(db, OWNER_B, a.id)).toThrow("not_found");
		const candidateId = a.candidates[0]?.id ?? 0;
		expect(() =>
			setCandidateStatus(db, OWNER_B, candidateId, "disabled", { nowIso: NOW }),
		).toThrow("not_found");
		expect(() =>
			addLocatorCandidate(db, OWNER_B, a.id, ATTRIBUTE_CANDIDATE, NOW),
		).toThrow("not_found");
		expect(() =>
			recordEvidence(db, OWNER_B, a.id, {
				outcome: "match",
				checkedAt: NOW,
				observationRef: "obs-1",
			}),
		).toThrow("not_found");
		expect(getSiteObject(db, OWNER_A, a.id)?.candidates[0]?.status).toBe(
			"candidate",
		);
	});
});

describe("candidates", () => {
	test("adding the same candidate again returns the stored one", () => {
		const db = openTransaction();
		setup(db);
		const object = write(db, { candidates: [ROLE_CANDIDATE] });
		const first = object.candidates[0];
		const again = addLocatorCandidate(
			db,
			OWNER_A,
			object.id,
			ROLE_CANDIDATE,
			LATER,
		);
		expect(again.added).toBe(false);
		expect(again.candidate).toEqual(first as typeof again.candidate);
		// Field order does not make a new candidate.
		const reordered = addLocatorCandidate(
			db,
			OWNER_A,
			object.id,
			{
				...ROLE_CANDIDATE,
				fields: { name: "Search the site", role: "searchbox" },
			},
			LATER,
		);
		expect(reordered.added).toBe(false);
		const other = addLocatorCandidate(
			db,
			OWNER_A,
			object.id,
			ATTRIBUTE_CANDIDATE,
			LATER,
		);
		expect(other.added).toBe(true);
		expect(other.candidate.status).toBe("candidate");
		// The same fields from another platform are a different candidate.
		const other2 = addLocatorCandidate(
			db,
			OWNER_A,
			object.id,
			{
				...ROLE_CANDIDATE,
				source: { adapter: "agent-browser", via: "snapshot" },
			},
			LATER,
		);
		expect(other2.added).toBe(true);
	});

	test("status changes one candidate at a time; verified needs a recorded match", () => {
		const db = openTransaction();
		setup(db);
		startedRun(db);
		const object = write(db, {
			candidates: [ROLE_CANDIDATE, ATTRIBUTE_CANDIDATE],
		});
		const [roleId, attrId] = object.candidates.map((c) => c.id) as [
			number,
			number,
		];

		expect(() =>
			setCandidateStatus(db, OWNER_A, roleId, "verified", { nowIso: NOW }),
		).toThrow("invalid_input");

		recordEvidence(db, OWNER_A, object.id, {
			candidateId: roleId,
			outcome: "match",
			checkedAt: NOW,
			runId: "run-1",
			setStatus: "verified",
		});
		let view = getSiteObject(db, OWNER_A, object.id);
		expect(view?.candidates.map((c) => c.status)).toEqual([
			"verified",
			"candidate",
		]);

		// A new mismatch turns only that candidate stale.
		recordEvidence(db, OWNER_A, object.id, {
			candidateId: roleId,
			outcome: "mismatch",
			checkedAt: LATER,
			runId: "run-1",
			setStatus: "stale",
		});
		setCandidateStatus(db, OWNER_A, attrId, "disabled", {
			nowIso: LATER,
			reason: "manual",
		});
		view = getSiteObject(db, OWNER_A, object.id);
		expect(view?.candidates.map((c) => [c.status, c.statusReason])).toEqual([
			["stale", "evidence_mismatch"],
			["disabled", "manual"],
		]);
		// Disabled candidates are hidden from `find` unless asked for, and never deleted.
		expect(
			findSiteObjects(db, OWNER_A, { origin: ORIGIN_X })[0]?.candidates,
		).toHaveLength(1);
		expect(
			findSiteObjects(db, OWNER_A, {
				origin: ORIGIN_X,
				includeDisabled: true,
			})[0]?.candidates,
		).toHaveLength(2);
		expect(count(db, "interact_locator_candidates")).toBe(2);
	});

	test("evidence status effects must fit the outcome", () => {
		const db = openTransaction();
		setup(db);
		const object = write(db, { candidates: [ROLE_CANDIDATE] });
		const candidateId = object.candidates[0]?.id ?? 0;
		for (const [outcome, setStatus] of [
			["mismatch", "verified"],
			["match", "stale"],
		] as const) {
			expect(() =>
				recordEvidence(db, OWNER_A, object.id, {
					candidateId,
					outcome,
					checkedAt: NOW,
					observationRef: "obs-1",
					setStatus,
				}),
			).toThrow("invalid_input");
		}
		// A status effect without a candidate makes no sense.
		expect(() =>
			recordEvidence(db, OWNER_A, object.id, {
				outcome: "match",
				checkedAt: NOW,
				observationRef: "obs-1",
				setStatus: "verified",
			}),
		).toThrow("invalid_input");
	});
});

describe("evidence", () => {
	test("needs a reference, belongs to the object's candidates and the owner's runs", () => {
		const db = openTransaction();
		setup(db);
		setup(db, OWNER_B);
		startedRun(db, OWNER_A, "run-a");
		startedRun(db, OWNER_B, "run-b");
		const a = write(db, { candidates: [ROLE_CANDIDATE] });
		const a2 = write(db, {
			logicalName: "search.submit",
			candidates: [ATTRIBUTE_CANDIDATE],
		});
		const base = { outcome: "match", checkedAt: NOW } as const;

		expect(() => recordEvidence(db, OWNER_A, a.id, base)).toThrow(
			"invalid_input",
		);
		// Another owner's run.
		expect(() =>
			recordEvidence(db, OWNER_A, a.id, { ...base, runId: "run-b" }),
		).toThrow("scope_mismatch");
		expect(() =>
			recordEvidence(db, OWNER_A, a.id, { ...base, runId: "no-such-run" }),
		).toThrow("scope_mismatch");
		// A candidate of another object.
		expect(() =>
			recordEvidence(db, OWNER_A, a.id, {
				...base,
				runId: "run-a",
				candidateId: a2.candidates[0]?.id ?? 0,
			}),
		).toThrow("scope_mismatch");
		expect(listEvidence(db, OWNER_A, a.id)).toEqual([]);
	});

	test("operation and run references must agree; evidence is listed newest first", () => {
		const db = openTransaction();
		setup(db);
		startedRun(db, OWNER_A, "run-a");
		startedRun(db, OWNER_A, "run-b");
		recordOperationIntent(db, OWNER_A, "run-a", {
			request: {
				operationId: "op-1",
				sessionId: "s",
				generation: 1,
				command: { action: "page.click", targetRef: "e1", element: "Go" },
				declaredEffect: "none",
			},
			nowIso: NOW,
		});
		markOperationDispatched(db, OWNER_A, "op-1", NOW);
		const object = write(db, { candidates: [ROLE_CANDIDATE] });
		const candidateId = object.candidates[0]?.id ?? 0;
		expect(() =>
			recordEvidence(db, OWNER_A, object.id, {
				outcome: "match",
				checkedAt: NOW,
				runId: "run-b",
				operationId: "op-1",
			}),
		).toThrow("scope_mismatch");
		recordEvidence(db, OWNER_A, object.id, {
			candidateId,
			outcome: "match",
			checkedAt: NOW,
			runId: "run-a",
			operationId: "op-1",
			observationRef: "obs-1",
			conditions: { lang: "ja", viewport: "desktop" },
		});
		recordEvidence(db, OWNER_A, object.id, {
			candidateId,
			outcome: "mismatch",
			checkedAt: LATER,
			observationRef: "obs-2",
		});
		const evidence = listEvidence(db, OWNER_A, object.id);
		expect(evidence.map((e) => e.outcome)).toEqual(["mismatch", "match"]);
		expect(evidence[1]).toMatchObject({
			runId: "run-a",
			operationId: "op-1",
			observationRef: "obs-1",
			objectRevision: 1,
			conditions: { lang: "ja", viewport: "desktop" },
		});
		expect(listEvidence(db, OWNER_A, object.id, { candidateId })).toHaveLength(
			2,
		);
	});

	test("forgetting a run keeps the evidence row but cuts the link", () => {
		const db = openTransaction();
		setup(db);
		startedRun(db, OWNER_A, "run-a");
		const object = write(db, { candidates: [ROLE_CANDIDATE] });
		recordEvidence(db, OWNER_A, object.id, {
			outcome: "match",
			checkedAt: NOW,
			runId: "run-a",
		});
		db.exec("DELETE FROM interact_runs WHERE run_id = 'run-a'");
		expect(listEvidence(db, OWNER_A, object.id)[0]?.runId).toBeNull();
	});
});

describe("one call keeps revision, candidates and evidence together", () => {
	test("discover, save, reuse, mismatch, revise", () => {
		const db = openTransaction();
		setup(db);
		startedRun(db);

		// Discovery: the object, two candidates and the evidence that confirms one of them.
		const first = write(db, {
			candidates: [ROLE_CANDIDATE, ATTRIBUTE_CANDIDATE],
			evidence: [
				{
					addedCandidate: 0,
					outcome: "match",
					checkedAt: NOW,
					runId: "run-1",
					observationRef: "obs-1",
					conditions: { lang: "ja" },
					setStatus: "verified",
				},
			],
		});
		expect(first.revision).toBe(1);
		expect(first.candidates.map((c) => c.status)).toEqual([
			"verified",
			"candidate",
		]);
		const roleId = first.candidates[0]?.id ?? 0;

		// Reuse: lookup by owner + origin + profile + name.
		const found = findSiteObjects(db, OWNER_A, {
			origin: ORIGIN_X,
			profile: "home",
			logicalName: "search.query",
		});
		expect(found).toEqual([first]);

		// Mismatch later: that candidate turns stale and a new candidate arrives with revision 2.
		const second = write(db, {
			expectedRevision: 1,
			candidates: [
				{
					kind: "test_id",
					fields: { testId: "search-input" },
					source: { adapter: "playwright-mcp", via: "inspectLocator" },
				},
			],
			evidence: [
				{
					candidateId: roleId,
					outcome: "mismatch",
					checkedAt: LATER,
					runId: "run-1",
					setStatus: "stale",
				},
				{
					addedCandidate: 0,
					outcome: "match",
					checkedAt: LATER,
					runId: "run-1",
					setStatus: "verified",
				},
			],
			nowIso: LATER,
		});
		expect(second.revision).toBe(2);
		expect(second.candidates.map((c) => c.status)).toEqual([
			"stale",
			"candidate",
			"verified",
		]);
		expect(
			listEvidence(db, OWNER_A, first.id).map((e) => e.objectRevision),
		).toEqual([2, 2, 1]);
	});

	test("a failing evidence part leaves no revision, candidate or evidence behind", () => {
		const db = openTransaction();
		setup(db);
		write(db, { candidates: [ROLE_CANDIDATE] });
		const before = dumpAllText(db);
		expect(() =>
			write(db, {
				expectedRevision: 1,
				candidates: [ATTRIBUTE_CANDIDATE],
				evidence: [
					{
						addedCandidate: 0,
						outcome: "match",
						checkedAt: NOW,
						runId: "missing-run",
					},
				],
			}),
		).toThrow("scope_mismatch");
		expect(() =>
			write(db, {
				expectedRevision: 1,
				evidence: [
					{
						addedCandidate: 3,
						outcome: "match",
						checkedAt: NOW,
						observationRef: "o",
					},
				],
			}),
		).toThrow("invalid_input");
		expect(dumpAllText(db)).toBe(before);
	});
});

describe("no secrets", () => {
	test("URL values with a query or fragment, or userinfo, are refused; plain values stay", () => {
		const db = openTransaction();
		setup(db);
		for (const value of [
			"https://a.example/cb?access_token=abc",
			"https://a.example/cb#access_token=abc",
			"HTTP://a.example?x=1",
			"https://u:p@a.example/x",
			"see https://a.example/x?sig=abc here",
		]) {
			expect(() =>
				write(db, {
					candidates: [{ ...ATTRIBUTE_CANDIDATE, fields: { href: value } }],
				}),
			).toThrow("invalid_input");
			expect(() =>
				upsertPageProfile(
					db,
					OWNER_A,
					ORIGIN_X,
					{ name: "x", conditions: { referrer: value } },
					NOW,
				),
			).toThrow("invalid_input");
		}
		write(db, {
			candidates: [
				{
					...ATTRIBUTE_CANDIDATE,
					fields: { href: "https://a.example/search", name: "q?" },
				},
			],
		});
		expect(dumpAllText(db)).not.toContain("access_token");
	});

	test("the tables hold no typed value even when it is offered in a locator", () => {
		const db = openTransaction();
		setup(db);
		for (const key of [
			"password",
			"token",
			"cookie",
			"Authorization",
			"apiSecret",
		]) {
			expect(() =>
				write(db, {
					candidates: [
						{ ...ATTRIBUTE_CANDIDATE, fields: { [key]: "hunter2" } },
					],
				}),
			).toThrow("invalid_input");
		}
		expect(dumpAllText(db)).not.toContain("hunter2");
	});
});
