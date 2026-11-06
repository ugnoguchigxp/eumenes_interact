import { PLATFORM_IDS, type PlatformId } from "../contracts/common.ts";
import type { InteractDb } from "../contracts/db.ts";
import {
	assertWritable,
	changedRows,
	guarded,
	isRecord,
	readBoolean,
	readInteger,
	readJson,
	readNullableInteger,
	readNullableText,
	readText,
} from "./db.ts";
import { InteractStoreError } from "./errors.ts";
import {
	flatFields,
	invalid,
	listLimit,
	optionalText,
	requireCode,
	requireId,
	requireInteger,
	requireOrigin,
	requireText,
	requireTimestamp,
	toJson,
	type FlatFields,
} from "./validate.ts";

/**
 * Site knowledge (plan.md §7). Everything is addressed through an owner and a normalized origin; a
 * lookup never crosses owners or origins, and a logical name is only unique inside one page profile.
 * Another owner's row answers as `not_found`. A page-supplied "remember this" is no input here: the
 * host decides what to write and attaches the source.
 */

export const CANDIDATE_KINDS = [
	"role",
	"label",
	"test_id",
	"attribute",
	"structure",
	"ax_identifier",
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export const CANDIDATE_STATUSES = [
	"candidate",
	"verified",
	"stale",
	"disabled",
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export type { FlatFields } from "./validate.ts";

function oneOf<T extends string>(
	list: readonly T[],
	value: unknown,
	field: string,
): T {
	if (
		typeof value !== "string" ||
		!(list as readonly string[]).includes(value)
	) {
		throw invalid(field);
	}
	return value as T;
}

function isFlatFields(value: unknown): value is FlatFields {
	return (
		isRecord(value) &&
		Object.values(value).every(
			(item) =>
				typeof item === "string" ||
				typeof item === "number" ||
				typeof item === "boolean",
		)
	);
}

function one(db: InteractDb, sql: string, ...params: (string | number)[]) {
	return guarded(() => db.query(sql).get(...params));
}

// ---- Scopes and page profiles ----

export type SiteScope = {
	id: number;
	owner: string;
	origin: string;
	createdAt: string;
};

function readScope(row: unknown): SiteScope {
	return {
		id: readInteger(row, "id"),
		owner: readText(row, "owner"),
		origin: readText(row, "origin"),
		createdAt: readText(row, "created_at"),
	};
}

export function getSiteScope(
	db: InteractDb,
	owner: string,
	origin: string,
): SiteScope | null {
	requireId(owner, "owner");
	requireOrigin(origin);
	const row = one(
		db,
		"SELECT id, owner, origin, created_at FROM interact_site_scopes WHERE owner = ? AND origin = ?",
		owner,
		origin,
	);
	return row == null ? null : readScope(row);
}

/** Forget an owner's origin-scoped knowledge and its dependent profiles, candidates and evidence. */
export function forgetSiteScope(
	db: InteractDb,
	owner: string,
	origin: string,
): void {
	assertWritable(db);
	requireId(owner, "owner");
	requireOrigin(origin);
	guarded(() =>
		db
			.query("DELETE FROM interact_site_scopes WHERE owner=? AND origin=?")
			.run(owner, origin),
	);
}

/** Creates the scope for an owner and a normalized origin, or returns the existing one. */
export function upsertSiteScope(
	db: InteractDb,
	owner: string,
	origin: string,
	nowIso: string,
): SiteScope {
	assertWritable(db);
	requireId(owner, "owner");
	requireOrigin(origin);
	const at = requireTimestamp(nowIso, "nowIso");
	guarded(() =>
		db
			.query(
				"INSERT OR IGNORE INTO interact_site_scopes (owner, origin, created_at) VALUES (?, ?, ?)",
			)
			.run(owner, origin, at),
	);
	const scope = getSiteScope(db, owner, origin);
	if (scope === null) throw new InteractStoreError("corrupt_row");
	return scope;
}

export type PageProfileInput = {
	name: string;
	description?: string;
	/** A path pattern such as `/search`; never a query string or a full URL. */
	urlHint?: string;
	/** Applicability: language, viewport, sign-in state, kind of screen… */
	conditions?: FlatFields;
	/** What identifies this screen. */
	basis?: string;
};

export type PageProfile = {
	id: number;
	scopeId: number;
	name: string;
	description: string | null;
	urlHint: string | null;
	conditions: FlatFields;
	basis: string | null;
	createdAt: string;
	updatedAt: string;
};

const PROFILE_COLUMNS =
	"id, scope_id, name, description, url_hint, conditions_json, basis, created_at, updated_at";

function readProfile(row: unknown): PageProfile {
	return {
		id: readInteger(row, "id"),
		scopeId: readInteger(row, "scope_id"),
		name: readText(row, "name"),
		description: readNullableText(row, "description"),
		urlHint: readNullableText(row, "url_hint"),
		conditions: readJson(row, "conditions_json", isFlatFields),
		basis: readNullableText(row, "basis"),
		createdAt: readText(row, "created_at"),
		updatedAt: readText(row, "updated_at"),
	};
}

/** Creates or replaces a page profile of an existing scope (identified by owner, origin and name). */
export function upsertPageProfile(
	db: InteractDb,
	owner: string,
	origin: string,
	input: PageProfileInput,
	nowIso: string,
): PageProfile {
	assertWritable(db);
	const name = requireText(input.name, "name", 128);
	const description = optionalText(input.description, "description", 1000);
	let urlHint: string | null = null;
	if (input.urlHint !== undefined) {
		urlHint = requireText(input.urlHint, "urlHint", 256);
		if (!urlHint.startsWith("/") || /[?#@]/.test(urlHint))
			throw invalid("urlHint");
	}
	const conditions = toJson(
		flatFields(input.conditions ?? {}, "conditions", { nonEmpty: false }),
		"conditions",
	);
	const basis = optionalText(input.basis, "basis", 1000);
	const at = requireTimestamp(nowIso, "nowIso");
	const scope = getSiteScope(db, owner, origin);
	if (scope === null) throw new InteractStoreError("not_found");
	guarded(() =>
		db
			.query(
				`INSERT INTO interact_page_profiles (scope_id, name, description, url_hint, conditions_json,
					basis, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (scope_id, name) DO UPDATE SET description = excluded.description,
					url_hint = excluded.url_hint, conditions_json = excluded.conditions_json,
					basis = excluded.basis, updated_at = excluded.updated_at`,
			)
			.run(scope.id, name, description, urlHint, conditions, basis, at, at),
	);
	const row = one(
		db,
		`SELECT ${PROFILE_COLUMNS} FROM interact_page_profiles WHERE scope_id = ? AND name = ?`,
		scope.id,
		name,
	);
	if (row == null) throw new InteractStoreError("corrupt_row");
	return readProfile(row);
}

export function listPageProfiles(
	db: InteractDb,
	owner: string,
	origin: string,
): PageProfile[] {
	const scope = getSiteScope(db, owner, origin);
	if (scope === null) return [];
	const rows = guarded(() =>
		db
			.query(
				`SELECT ${PROFILE_COLUMNS} FROM interact_page_profiles WHERE scope_id = ? ORDER BY name`,
			)
			.all(scope.id),
	);
	return rows.map((row) => readProfile(row));
}

// ---- Candidates and evidence ----

export type CandidateInput = {
	kind: CandidateKind;
	/** Flat fields of the locator (`role`, `name`, `tag`…). Never a ref, coordinates or a credential. */
	fields: FlatFields;
	/** Which platform read it and which fixed inspection (`snapshot`, `inspectLocator`…). Required. */
	source: { adapter: PlatformId; via: string };
};

export type CandidateRecord = {
	id: number;
	objectId: number;
	kind: CandidateKind;
	fields: FlatFields;
	status: CandidateStatus;
	statusReason: string | null;
	statusChangedAt: string;
	source: { adapter: PlatformId; via: string };
	addedRevision: number;
	createdAt: string;
};

const CANDIDATE_COLUMNS = `id, object_id, kind, fields_json, status, status_reason, status_changed_at,
	source_adapter, source_via, added_revision, created_at`;

function readCandidate(row: unknown): CandidateRecord {
	return {
		id: readInteger(row, "id"),
		objectId: readInteger(row, "object_id"),
		kind: oneOf(CANDIDATE_KINDS, readText(row, "kind"), "kind"),
		fields: readJson(row, "fields_json", isFlatFields),
		status: oneOf(CANDIDATE_STATUSES, readText(row, "status"), "status"),
		statusReason: readNullableText(row, "status_reason"),
		statusChangedAt: readText(row, "status_changed_at"),
		source: {
			adapter: oneOf(PLATFORM_IDS, readText(row, "source_adapter"), "source"),
			via: readText(row, "source_via"),
		},
		addedRevision: readInteger(row, "added_revision"),
		createdAt: readText(row, "created_at"),
	};
}

type CheckedCandidate = {
	kind: CandidateKind;
	fieldsJson: string;
	adapter: PlatformId;
	via: string;
};

function checkCandidate(input: CandidateInput): CheckedCandidate {
	const kind = oneOf(CANDIDATE_KINDS, input.kind, "kind");
	const fields = flatFields(input.fields, "fields", { nonEmpty: true });
	const source: unknown = input.source;
	if (!isRecord(source)) throw invalid("source");
	const adapter = oneOf(PLATFORM_IDS, source["adapter"], "source.adapter");
	const via = source["via"];
	if (typeof via !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(via)) {
		throw invalid("source.via");
	}
	return { kind, fieldsJson: toJson(fields, "fields"), adapter, via };
}

/** Inserts a candidate as `candidate`, or returns the identical one that already exists. */
function insertCandidate(
	db: InteractDb,
	objectId: number,
	revision: number,
	candidate: CheckedCandidate,
	at: string,
): { id: number; added: boolean } {
	const existing = one(
		db,
		`SELECT id FROM interact_locator_candidates WHERE object_id = ? AND kind = ? AND fields_json = ?
			AND source_adapter = ? AND source_via = ?`,
		objectId,
		candidate.kind,
		candidate.fieldsJson,
		candidate.adapter,
		candidate.via,
	);
	if (existing != null)
		return { id: readInteger(existing, "id"), added: false };
	guarded(() =>
		db
			.query(
				`INSERT INTO interact_locator_candidates (object_id, kind, fields_json, status_changed_at,
					source_adapter, source_via, added_revision, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				objectId,
				candidate.kind,
				candidate.fieldsJson,
				at,
				candidate.adapter,
				candidate.via,
				revision,
				at,
			),
	);
	const row = one(db, "SELECT last_insert_rowid() AS id");
	return { id: readInteger(row, "id"), added: true };
}

/**
 * Changes one candidate's status. `verified` needs a recorded `match` for that candidate; the other
 * statuses are free. There is no bulk form: each candidate is judged on its own evidence.
 */
function applyCandidateStatus(
	db: InteractDb,
	candidateId: number,
	status: CandidateStatus,
	reason: string | null,
	at: string,
): void {
	if (status === "verified") {
		const match = one(
			db,
			"SELECT 1 AS one FROM interact_object_evidence WHERE candidate_id = ? AND outcome = 'match' LIMIT 1",
			candidateId,
		);
		if (match == null) throw invalid("status");
	}
	guarded(() =>
		db
			.query(
				`UPDATE interact_locator_candidates SET status = ?, status_reason = ?, status_changed_at = ?
				WHERE id = ? AND status <> ?`,
			)
			.run(status, reason, at, candidateId, status),
	);
}

type ObjectRef = { id: number; scopeId: number; revision: number };

function requireObjectRef(
	db: InteractDb,
	owner: string,
	objectId: number,
): ObjectRef {
	requireId(owner, "owner");
	requireInteger(objectId, "objectId", 1);
	const row = one(
		db,
		`SELECT o.id, o.scope_id, o.revision FROM interact_site_objects o
		JOIN interact_site_scopes s ON s.id = o.scope_id
		WHERE s.owner = ? AND o.id = ?`,
		owner,
		objectId,
	);
	if (row == null) throw new InteractStoreError("not_found");
	return {
		id: readInteger(row, "id"),
		scopeId: readInteger(row, "scope_id"),
		revision: readInteger(row, "revision"),
	};
}

/**
 * Adds a locator candidate to an object (status `candidate`; source adapter and `via` are required).
 * The same candidate again returns the stored one unchanged. Does not change the object's revision.
 */
export function addLocatorCandidate(
	db: InteractDb,
	owner: string,
	objectId: number,
	input: CandidateInput,
	nowIso: string,
): { candidate: CandidateRecord; added: boolean } {
	assertWritable(db);
	const checked = checkCandidate(input);
	const at = requireTimestamp(nowIso, "nowIso");
	const object = requireObjectRef(db, owner, objectId);
	const { id, added } = insertCandidate(
		db,
		object.id,
		object.revision,
		checked,
		at,
	);
	return { candidate: requireCandidate(db, id), added };
}

function requireCandidate(
	db: InteractDb,
	candidateId: number,
): CandidateRecord {
	const row = one(
		db,
		`SELECT ${CANDIDATE_COLUMNS} FROM interact_locator_candidates WHERE id = ?`,
		candidateId,
	);
	if (row == null) throw new InteractStoreError("not_found");
	return readCandidate(row);
}

/** Sets one candidate's status (see `applyCandidateStatus` for the one rule). */
export function setCandidateStatus(
	db: InteractDb,
	owner: string,
	candidateId: number,
	status: CandidateStatus,
	options: { nowIso: string; reason?: string },
): CandidateRecord {
	assertWritable(db);
	oneOf(CANDIDATE_STATUSES, status, "status");
	const at = requireTimestamp(options.nowIso, "nowIso");
	const reason =
		options.reason === undefined ? null : requireCode(options.reason, "reason");
	requireInteger(candidateId, "candidateId", 1);
	const row = one(
		db,
		`SELECT c.object_id FROM interact_locator_candidates c
		JOIN interact_site_objects o ON o.id = c.object_id
		JOIN interact_site_scopes s ON s.id = o.scope_id
		WHERE s.owner = ? AND c.id = ?`,
		owner,
		candidateId,
	);
	if (row == null) throw new InteractStoreError("not_found");
	applyCandidateStatus(db, candidateId, status, reason, at);
	return requireCandidate(db, candidateId);
}

export type EvidenceInput = {
	/** An existing candidate of the object. Omit for object-level evidence. */
	candidateId?: number;
	/** Or the index into the `candidates` of the same `writeSiteObject` call. */
	addedCandidate?: number;
	outcome: "match" | "mismatch";
	/** ISO 8601 UTC time of the check. */
	checkedAt: string;
	/** Under which conditions it was checked (language, viewport, sign-in state…). */
	conditions?: FlatFields;
	/** At least one of the three references is required. */
	runId?: string;
	operationId?: string;
	observationRef?: string;
	/** Also set the candidate's status: `verified` needs `match`, `stale` needs `mismatch`. */
	setStatus?: CandidateStatus;
};

export type EvidenceRecord = {
	id: number;
	objectId: number;
	candidateId: number | null;
	objectRevision: number;
	runId: string | null;
	operationId: string | null;
	observationRef: string | null;
	outcome: "match" | "mismatch";
	conditions: FlatFields;
	checkedAt: string;
};

type CheckedEvidence = {
	candidateId: number | null;
	addedCandidate: number | null;
	outcome: "match" | "mismatch";
	checkedAt: string;
	conditionsJson: string;
	runId: string | null;
	operationId: string | null;
	observationRef: string | null;
	setStatus: CandidateStatus | null;
};

function checkEvidence(input: EvidenceInput): CheckedEvidence {
	const outcome = oneOf(["match", "mismatch"], input.outcome, "outcome");
	const runId =
		input.runId === undefined ? null : requireId(input.runId, "runId");
	const operationId =
		input.operationId === undefined
			? null
			: requireId(input.operationId, "operationId");
	const observationRef = optionalText(
		input.observationRef,
		"observationRef",
		256,
	);
	if (runId === null && operationId === null && observationRef === null) {
		throw invalid("evidence");
	}
	const candidateId =
		input.candidateId === undefined
			? null
			: requireInteger(input.candidateId, "candidateId", 1);
	const addedCandidate =
		input.addedCandidate === undefined
			? null
			: requireInteger(input.addedCandidate, "addedCandidate", 0);
	if (candidateId !== null && addedCandidate !== null) {
		throw invalid("candidateId");
	}
	const setStatus =
		input.setStatus === undefined
			? null
			: oneOf(CANDIDATE_STATUSES, input.setStatus, "setStatus");
	if (
		setStatus !== null &&
		((candidateId === null && addedCandidate === null) ||
			(setStatus === "verified" && outcome !== "match") ||
			(setStatus === "stale" && outcome !== "mismatch"))
	) {
		throw invalid("setStatus");
	}
	return {
		candidateId,
		addedCandidate,
		outcome,
		checkedAt: requireTimestamp(input.checkedAt, "checkedAt"),
		conditionsJson: toJson(
			flatFields(input.conditions ?? {}, "conditions", { nonEmpty: false }),
			"conditions",
		),
		runId,
		operationId,
		observationRef,
		setStatus,
	};
}

/** The referenced run and operation must be this owner's (and agree with each other). */
function assertEvidenceSources(
	db: InteractDb,
	owner: string,
	evidence: CheckedEvidence,
): void {
	if (evidence.runId !== null) {
		const run = one(
			db,
			"SELECT 1 AS one FROM interact_runs WHERE owner = ? AND run_id = ?",
			owner,
			evidence.runId,
		);
		if (run == null) throw new InteractStoreError("scope_mismatch");
	}
	if (evidence.operationId !== null) {
		const operation = one(
			db,
			`SELECT o.run_id FROM interact_operations o JOIN interact_runs r ON r.run_id = o.run_id
			WHERE r.owner = ? AND o.operation_id = ?`,
			owner,
			evidence.operationId,
		);
		if (operation == null) throw new InteractStoreError("scope_mismatch");
		if (
			evidence.runId !== null &&
			readText(operation, "run_id") !== evidence.runId
		) {
			throw new InteractStoreError("scope_mismatch");
		}
	}
}

function assertCandidateOfObject(
	db: InteractDb,
	objectId: number,
	candidateId: number,
): void {
	const row = one(
		db,
		"SELECT 1 AS one FROM interact_locator_candidates WHERE id = ? AND object_id = ?",
		candidateId,
		objectId,
	);
	if (row == null) throw new InteractStoreError("scope_mismatch");
}

function insertEvidence(
	db: InteractDb,
	objectId: number,
	objectRevision: number,
	candidateId: number | null,
	evidence: CheckedEvidence,
): number {
	guarded(() =>
		db
			.query(
				`INSERT INTO interact_object_evidence (object_id, candidate_id, object_revision, run_id,
					operation_id, observation_ref, outcome, conditions_json, checked_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				objectId,
				candidateId,
				objectRevision,
				evidence.runId,
				evidence.operationId,
				evidence.observationRef,
				evidence.outcome,
				evidence.conditionsJson,
				evidence.checkedAt,
			),
	);
	const id = readInteger(one(db, "SELECT last_insert_rowid() AS id"), "id");
	if (candidateId !== null && evidence.setStatus !== null) {
		applyCandidateStatus(
			db,
			candidateId,
			evidence.setStatus,
			`evidence_${evidence.outcome}`,
			evidence.checkedAt,
		);
	}
	return id;
}

/**
 * Records one piece of evidence for an object (and optionally one of its candidates). `addedCandidate`
 * is only meaningful in `writeSiteObject`. Evidence rows are history: nothing here updates or deletes them.
 */
export function recordEvidence(
	db: InteractDb,
	owner: string,
	objectId: number,
	input: EvidenceInput,
): number {
	assertWritable(db);
	const evidence = checkEvidence(input);
	if (evidence.addedCandidate !== null) throw invalid("addedCandidate");
	const object = requireObjectRef(db, owner, objectId);
	assertEvidenceSources(db, owner, evidence);
	if (evidence.candidateId !== null) {
		assertCandidateOfObject(db, object.id, evidence.candidateId);
	}
	return insertEvidence(
		db,
		object.id,
		object.revision,
		evidence.candidateId,
		evidence,
	);
}

function readEvidence(row: unknown): EvidenceRecord {
	return {
		id: readInteger(row, "id"),
		objectId: readInteger(row, "object_id"),
		candidateId: readNullableInteger(row, "candidate_id"),
		objectRevision: readInteger(row, "object_revision"),
		runId: readNullableText(row, "run_id"),
		operationId: readNullableText(row, "operation_id"),
		observationRef: readNullableText(row, "observation_ref"),
		outcome: oneOf(["match", "mismatch"], readText(row, "outcome"), "outcome"),
		conditions: readJson(row, "conditions_json", isFlatFields),
		checkedAt: readText(row, "checked_at"),
	};
}

/** Evidence of an object, newest first. */
export function listEvidence(
	db: InteractDb,
	owner: string,
	objectId: number,
	options: { candidateId?: number; limit?: number } = {},
): EvidenceRecord[] {
	const object = requireObjectRef(db, owner, objectId);
	const candidateId =
		options.candidateId === undefined
			? null
			: requireInteger(options.candidateId, "candidateId", 1);
	const rows = guarded(() =>
		db
			.query(
				`SELECT id, object_id, candidate_id, object_revision, run_id, operation_id, observation_ref,
					outcome, conditions_json, checked_at
				FROM interact_object_evidence WHERE object_id = ? AND (? IS NULL OR candidate_id = ?)
				ORDER BY checked_at DESC, id DESC LIMIT ?`,
			)
			.all(object.id, candidateId, candidateId, listLimit(options.limit)),
	);
	return rows.map((row) => readEvidence(row));
}

// ---- Site objects ----

export type SiteObjectView = {
	id: number;
	origin: string;
	profile: { id: number; name: string };
	logicalName: string;
	role: string | null;
	description: string | null;
	region: string | null;
	important: boolean;
	revision: number;
	createdAt: string;
	updatedAt: string;
	candidates: CandidateRecord[];
};

const OBJECT_SELECT = `SELECT o.id, s.origin, p.id AS profile_id, p.name AS profile_name, o.logical_name,
	o.role, o.description, o.region, o.important, o.revision, o.created_at, o.updated_at
	FROM interact_site_objects o
	JOIN interact_page_profiles p ON p.id = o.page_profile_id
	JOIN interact_site_scopes s ON s.id = o.scope_id`;

function readObject(db: InteractDb, row: unknown, includeDisabled: boolean) {
	const id = readInteger(row, "id");
	const candidates = guarded(() =>
		db
			.query(
				`SELECT ${CANDIDATE_COLUMNS} FROM interact_locator_candidates
				WHERE object_id = ? AND (? OR status <> 'disabled') ORDER BY id`,
			)
			.all(id, includeDisabled ? 1 : 0),
	);
	const view: SiteObjectView = {
		id,
		origin: readText(row, "origin"),
		profile: {
			id: readInteger(row, "profile_id"),
			name: readText(row, "profile_name"),
		},
		logicalName: readText(row, "logical_name"),
		role: readNullableText(row, "role"),
		description: readNullableText(row, "description"),
		region: readNullableText(row, "region"),
		important: readBoolean(row, "important"),
		revision: readInteger(row, "revision"),
		createdAt: readText(row, "created_at"),
		updatedAt: readText(row, "updated_at"),
		candidates: candidates.map((candidate) => readCandidate(candidate)),
	};
	return view;
}

/**
 * Site objects of one owner and one origin, optionally one page profile and one logical name. The
 * origin is required: a name alone never resolves across sites. Disabled candidates are left out
 * unless asked for.
 */
export function findSiteObjects(
	db: InteractDb,
	owner: string,
	query: {
		origin: string;
		profile?: string;
		logicalName?: string;
		includeDisabled?: boolean;
	},
): SiteObjectView[] {
	requireId(owner, "owner");
	requireOrigin(query.origin);
	const profile =
		query.profile === undefined
			? null
			: requireText(query.profile, "profile", 128);
	const logicalName =
		query.logicalName === undefined
			? null
			: requireText(query.logicalName, "logicalName", 128);
	const rows = guarded(() =>
		db
			.query(
				`${OBJECT_SELECT} WHERE s.owner = ? AND s.origin = ? AND (? IS NULL OR p.name = ?)
				AND (? IS NULL OR o.logical_name = ?) ORDER BY p.name, o.logical_name`,
			)
			.all(owner, query.origin, profile, profile, logicalName, logicalName),
	);
	return rows.map((row) => readObject(db, row, query.includeDisabled === true));
}

/** One object of this owner by its id, with all candidates, or `null`. */
export function getSiteObject(
	db: InteractDb,
	owner: string,
	objectId: number,
): SiteObjectView | null {
	requireId(owner, "owner");
	requireInteger(objectId, "objectId", 1);
	const row = guarded(() =>
		db
			.query(`${OBJECT_SELECT} WHERE s.owner = ? AND o.id = ?`)
			.get(owner, objectId),
	);
	return row == null ? null : readObject(db, row, true);
}

export type WriteSiteObjectInput = {
	origin: string;
	/** The page profile's name; the profile must exist (`upsertPageProfile`). */
	profile: string;
	logicalName: string;
	/** 0 to create (the object must not exist); otherwise the revision the caller read. */
	expectedRevision: number;
	/** Omitted fields keep their stored value (on create: empty). */
	role?: string;
	description?: string;
	region?: string;
	important?: boolean;
	/** New candidates (status `candidate`). */
	candidates?: readonly CandidateInput[];
	evidence?: readonly EvidenceInput[];
	nowIso: string;
};

/**
 * Creates or revises a site object together with its new candidates and evidence, so the host's one
 * transaction covers everything that belongs together (plan.md §7.1). A stale `expectedRevision` is a
 * `revision_conflict` and nothing is written. Everything is checked before the first write.
 */
export function writeSiteObject(
	db: InteractDb,
	owner: string,
	input: WriteSiteObjectInput,
): SiteObjectView {
	assertWritable(db);
	requireId(owner, "owner");
	const origin = requireOrigin(input.origin);
	const profileName = requireText(input.profile, "profile", 128);
	const logicalName = requireId(input.logicalName, "logicalName");
	const expected = requireInteger(
		input.expectedRevision,
		"expectedRevision",
		0,
	);
	const role = optionalText(input.role, "role", 128);
	const description = optionalText(input.description, "description", 1000);
	const region = optionalText(input.region, "region", 256);
	if (input.important !== undefined && typeof input.important !== "boolean") {
		throw invalid("important");
	}
	const at = requireTimestamp(input.nowIso, "nowIso");
	const candidates = (input.candidates ?? []).map(checkCandidate);
	const evidence = (input.evidence ?? []).map(checkEvidence);

	const profileRow = one(
		db,
		`SELECT p.id, p.scope_id FROM interact_page_profiles p
		JOIN interact_site_scopes s ON s.id = p.scope_id
		WHERE s.owner = ? AND s.origin = ? AND p.name = ?`,
		owner,
		origin,
		profileName,
	);
	if (profileRow == null) throw new InteractStoreError("not_found");
	const profileId = readInteger(profileRow, "id");
	const scopeId = readInteger(profileRow, "scope_id");

	const existingRow = one(
		db,
		`${OBJECT_SELECT} WHERE o.page_profile_id = ? AND o.logical_name = ?`,
		profileId,
		logicalName,
	);
	const existing =
		existingRow == null ? null : readObject(db, existingRow, true);
	if (existing === null && expected > 0)
		throw new InteractStoreError("not_found");
	if (existing !== null && existing.revision !== expected) {
		throw new InteractStoreError("revision_conflict");
	}
	const revision = (existing?.revision ?? 0) + 1;

	for (const item of evidence) {
		assertEvidenceSources(db, owner, item);
		if (
			item.addedCandidate !== null &&
			item.addedCandidate >= candidates.length
		) {
			throw invalid("addedCandidate");
		}
		if (item.candidateId !== null) {
			if (existing === null) throw new InteractStoreError("scope_mismatch");
			assertCandidateOfObject(db, existing.id, item.candidateId);
		}
	}

	let objectId: number;
	if (existing === null) {
		guarded(() =>
			db
				.query(
					`INSERT INTO interact_site_objects (scope_id, page_profile_id, logical_name, role,
						description, region, important, revision, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				)
				.run(
					scopeId,
					profileId,
					logicalName,
					role,
					description,
					region,
					input.important === true ? 1 : 0,
					at,
					at,
				),
		);
		objectId = readInteger(one(db, "SELECT last_insert_rowid() AS id"), "id");
	} else {
		objectId = existing.id;
		guarded(() => {
			db.query(
				`UPDATE interact_site_objects SET role = ?, description = ?, region = ?, important = ?,
					revision = ?, updated_at = ? WHERE id = ? AND revision = ?`,
			).run(
				role ?? existing.role,
				description ?? existing.description,
				region ?? existing.region,
				(input.important ?? existing.important) ? 1 : 0,
				revision,
				at,
				objectId,
				existing.revision,
			);
			// Lost to a concurrent save of the same object: nothing was written.
			if (changedRows(db) !== 1) {
				throw new InteractStoreError("revision_conflict");
			}
		});
	}

	const addedIds = candidates.map(
		(candidate) => insertCandidate(db, objectId, revision, candidate, at).id,
	);
	for (const item of evidence) {
		const candidateId =
			item.addedCandidate === null
				? item.candidateId
				: (addedIds[item.addedCandidate] ?? null);
		insertEvidence(db, objectId, revision, candidateId, item);
	}
	const view = getSiteObject(db, owner, objectId);
	if (view === null) throw new InteractStoreError("corrupt_row");
	return view;
}
