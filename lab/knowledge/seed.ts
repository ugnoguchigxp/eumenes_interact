import type { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	findSiteObjects,
	getSiteScope,
	listPageProfiles,
	setCandidateStatus,
	upsertPageProfile,
	upsertSiteScope,
	writeSiteObject,
	type CandidateInput,
	type SiteObjectView,
} from "eumenes-interact/sqlite";
import { write } from "../host/db.ts";

/**
 * Site knowledge seeds (plan.md §7): the page profiles and logical objects of a site, written by hand from
 * what a probe of the real site showed, and imported into the research SQLite as `candidate`s (never as
 * verified: a seed is a claim to be checked against the page on every use). Importing is idempotent; a
 * changed seed revises the object under its expected revision and disables the candidates it no longer has.
 */

export const KNOWLEDGE_DIR = fileURLToPath(new URL(".", import.meta.url));

const LOGICAL_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

/** The fields each candidate kind may carry, all of them read by `candidates.ts`. */
const FIELDS = {
	role: ["role", "name", "nameAnyOf", "nth"],
	structure: [
		"role",
		"name",
		"nameAnyOf",
		"named",
		"urlIncludes",
		"urlExcludes",
		"withinRole",
		"nth",
	],
} as const;

const fieldValue = z.union([z.string().min(1), z.number(), z.boolean()]);

const candidateSchema = z
	.strictObject({
		kind: z.enum(["role", "structure"]),
		fields: z.record(z.string(), fieldValue),
		source: z.strictObject({
			adapter: z.literal("playwright-mcp"),
			via: z.literal("snapshot"),
		}),
	})
	.superRefine((c, ctx) => {
		const allowed: readonly string[] = FIELDS[c.kind];
		for (const key of Object.keys(c.fields))
			if (!allowed.includes(key))
				ctx.addIssue({
					code: "custom",
					path: ["fields", key],
					message: `not a field of a ${c.kind} candidate`,
				});
		if (c.fields.role === undefined)
			ctx.addIssue({
				code: "custom",
				path: ["fields", "role"],
				message: "role is required",
			});
		if (c.fields.name !== undefined && c.fields.nameAnyOf !== undefined)
			ctx.addIssue({
				code: "custom",
				path: ["fields"],
				message: "name or nameAnyOf, not both",
			});
	});

export const seedSchema = z
	.strictObject({
		/** Exact origins sharing this seed: every one gets the same profiles and objects. */
		origins: z
			.array(z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/))
			.min(1),
		pageProfiles: z
			.array(
				z.strictObject({
					name: z.string().min(1).max(128),
					/** A path prefix; the longest one matching the page wins, `/` is the fallback. */
					urlHint: z.string().regex(/^\/[^?#@]*$/),
					description: z.string().min(1).max(1000),
				}),
			)
			.min(1),
		objects: z.array(
			z.strictObject({
				profile: z.string().min(1),
				logicalName: z.string().regex(LOGICAL_NAME).max(64),
				description: z.string().min(1).max(1000),
				candidates: z.array(candidateSchema).min(1),
			}),
		),
	})
	.superRefine((seed, ctx) => {
		const profiles = new Set(seed.pageProfiles.map((p) => p.name));
		if (profiles.size !== seed.pageProfiles.length)
			ctx.addIssue({
				code: "custom",
				path: ["pageProfiles"],
				message: "duplicate profile",
			});
		const seen = new Set<string>();
		seed.objects.forEach((o, i) => {
			if (!profiles.has(o.profile))
				ctx.addIssue({
					code: "custom",
					path: ["objects", i, "profile"],
					message: "unknown profile",
				});
			const key = `${o.profile}/${o.logicalName}`;
			if (seen.has(key))
				ctx.addIssue({
					code: "custom",
					path: ["objects", i],
					message: "duplicate object",
				});
			seen.add(key);
		});
	});
export type Seed = z.infer<typeof seedSchema>;

/** The seed files of a directory (default: this one), parsed. A bad file is an error naming it, not a skip. */
export async function loadSeeds(
	dir: string = KNOWLEDGE_DIR,
): Promise<{ file: string; seed: Seed }[]> {
	const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
	return Promise.all(
		names.map(async (name) => ({
			file: name,
			seed: await readSeed(join(dir, name)),
		})),
	);
}

export async function readSeed(path: string): Promise<Seed> {
	const parsed = seedSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
	if (!parsed.success)
		throw new Error(
			`invalid_seed:${path}:${parsed.error.issues
				.slice(0, 5)
				.map((i) => `${i.path.join(".")}:${i.message}`)
				.join(",")}`,
		);
	return parsed.data;
}

export type ImportReport = {
	origin: string;
	profiles: number;
	created: number;
	revised: number;
	unchanged: number;
};

const toInput = (
	c: Seed["objects"][number]["candidates"][number],
): CandidateInput => ({
	kind: c.kind,
	fields: c.fields,
	source: c.source,
});

/** A candidate as comparable text: kind, fields in key order, source. */
const signature = (c: {
	kind: string;
	fields: Readonly<Record<string, string | number | boolean>>;
	source: { adapter: string; via: string };
}) =>
	JSON.stringify([
		c.kind,
		Object.entries(c.fields).sort(([a], [b]) => (a < b ? -1 : 1)),
		c.source.adapter,
		c.source.via,
	]);

function importObject(
	db: Database,
	owner: string,
	origin: string,
	object: Seed["objects"][number],
	nowIso: string,
): "created" | "revised" | "unchanged" {
	const existing: SiteObjectView | undefined = findSiteObjects(db, owner, {
		origin,
		profile: object.profile,
		logicalName: object.logicalName,
	})[0];
	if (!existing)
		return (
			writeSiteObject(db, owner, {
				origin,
				profile: object.profile,
				logicalName: object.logicalName,
				expectedRevision: 0,
				description: object.description,
				candidates: object.candidates.map(toInput),
				nowIso,
			}),
			"created"
		);
	// Active candidates only: one the user disabled stays disabled and is not part of the comparison.
	const have = new Map(existing.candidates.map((c) => [signature(c), c]));
	const want = new Set(object.candidates.map((c) => signature(c)));
	const added = object.candidates.filter((c) => !have.has(signature(c)));
	const removed = existing.candidates.filter((c) => !want.has(signature(c)));
	if (
		added.length === 0 &&
		removed.length === 0 &&
		existing.description === object.description
	)
		return "unchanged";
	writeSiteObject(db, owner, {
		origin,
		profile: object.profile,
		logicalName: object.logicalName,
		expectedRevision: existing.revision,
		description: object.description,
		candidates: added.map(toInput),
		nowIso,
	});
	for (const c of removed)
		setCandidateStatus(db, owner, c.id, "disabled", {
			nowIso,
			reason: "seed_changed",
		});
	// A candidate the seed brings back after an earlier change is on again, unless a user disabled it.
	const wanted = new Set(added.map((c) => signature(c)));
	const revised = findSiteObjects(db, owner, {
		origin,
		profile: object.profile,
		logicalName: object.logicalName,
		includeDisabled: true,
	})[0];
	for (const c of revised?.candidates ?? [])
		if (
			c.status === "disabled" &&
			c.statusReason === "seed_changed" &&
			wanted.has(signature(c))
		)
			setCandidateStatus(db, owner, c.id, "candidate", { nowIso });
	return "revised";
}

/** Imports one seed for every origin it names, in one transaction. */
export function importSeed(
	db: Database,
	owner: string,
	seed: Seed,
	nowIso: string,
): ImportReport[] {
	return write(db, () =>
		seed.origins.map((origin) => {
			upsertSiteScope(db, owner, origin, nowIso);
			const stored = new Map(
				listPageProfiles(db, owner, origin).map((p) => [p.name, p]),
			);
			for (const p of seed.pageProfiles) {
				const same = stored.get(p.name);
				if (same?.urlHint === p.urlHint && same.description === p.description)
					continue;
				upsertPageProfile(db, owner, origin, p, nowIso);
			}
			const report: ImportReport = {
				origin,
				profiles: seed.pageProfiles.length,
				created: 0,
				revised: 0,
				unchanged: 0,
			};
			for (const object of seed.objects)
				report[importObject(db, owner, origin, object, nowIso)]++;
			return report;
		}),
	);
}

export type KnowledgeListing = {
	origin: string;
	profiles: { name: string; urlHint: string | null }[];
	objects: {
		profile: string;
		logicalName: string;
		revision: number;
		candidates: {
			kind: string;
			status: string;
			fields: Record<string, string | number | boolean>;
		}[];
	}[];
};

/** What is stored, per origin (all origins, or the one asked for). */
export function listKnowledge(
	db: Database,
	owner: string,
	origin?: string,
): KnowledgeListing[] {
	const origins =
		origin !== undefined
			? getSiteScope(db, owner, origin)
				? [origin]
				: []
			: (
					db
						.query(
							"SELECT origin FROM interact_site_scopes WHERE owner = ? ORDER BY origin",
						)
						.all(owner) as { origin: string }[]
				).map((r) => r.origin);
	return origins.map((o) => ({
		origin: o,
		profiles: listPageProfiles(db, owner, o).map((p) => ({
			name: p.name,
			urlHint: p.urlHint,
		})),
		objects: findSiteObjects(db, owner, {
			origin: o,
			includeDisabled: true,
		}).map((v) => ({
			profile: v.profile.name,
			logicalName: v.logicalName,
			revision: v.revision,
			candidates: v.candidates.map((c) => ({
				kind: c.kind,
				status: c.status,
				fields: { ...c.fields },
			})),
		})),
	}));
}
