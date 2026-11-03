import type { InteractDb } from "../contracts/db.ts";
import {
	assertWritable,
	guarded,
	isRecord,
	readInteger,
	readJson,
	readText,
} from "./db.ts";
import { InteractStoreError } from "./errors.ts";
import {
	invalid,
	requireDigest,
	requireId,
	requireInteger,
	requireText,
	requireTimestamp,
	toJson,
} from "./validate.ts";

/** JSON with sorted keys, so key order alone never makes two definitions differ. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export type WorkflowRevisionInput = {
	workflowId: string;
	revision: number;
	formatVersion: number;
	/** The host's digest of the definition (the package has no hashing of its own). */
	digest: string;
	skillRef: string;
	catalogRef: string;
	/** The published definition. It holds no input values (plan.md §6.2). */
	definition: Readonly<Record<string, unknown>>;
	nowIso: string;
};

export type WorkflowRevision = Omit<WorkflowRevisionInput, "nowIso"> & {
	createdAt: string;
};

function readRevision(row: unknown): WorkflowRevision {
	return {
		workflowId: readText(row, "workflow_id"),
		revision: readInteger(row, "revision"),
		formatVersion: readInteger(row, "format_version"),
		digest: readText(row, "digest"),
		skillRef: readText(row, "skill_ref"),
		catalogRef: readText(row, "catalog_ref"),
		definition: readJson(row, "definition_json", isRecord),
		createdAt: readText(row, "created_at"),
	};
}

const COLUMNS = `workflow_id, revision, format_version, digest, skill_ref, catalog_ref,
	definition_json, created_at`;

/**
 * Registers a published revision. It is immutable: registering the same id and revision again with
 * identical content (digest, refs, format and definition) returns the stored one; any difference is a `revision_conflict`.
 */
export function registerWorkflowRevision(
	db: InteractDb,
	owner: string,
	input: WorkflowRevisionInput,
): WorkflowRevision {
	assertWritable(db);
	requireId(owner, "owner");
	const workflowId = requireId(input.workflowId, "workflowId");
	const revision = requireInteger(input.revision, "revision", 1);
	const formatVersion = requireInteger(input.formatVersion, "formatVersion", 1);
	const digest = requireDigest(input.digest, "digest");
	const skillRef = requireText(input.skillRef, "skillRef", 128);
	const catalogRef = requireText(input.catalogRef, "catalogRef", 128);
	if (!isRecord(input.definition)) throw invalid("definition");
	const definitionJson = toJson(input.definition, "definition");
	const nowIso = requireTimestamp(input.nowIso, "nowIso");

	const existing = getWorkflowRevision(db, owner, workflowId, revision);
	if (existing !== null) {
		const same =
			existing.digest === digest &&
			existing.formatVersion === formatVersion &&
			existing.skillRef === skillRef &&
			existing.catalogRef === catalogRef &&
			canonicalJson(existing.definition) === canonicalJson(input.definition);
		if (!same) throw new InteractStoreError("revision_conflict");
		return existing;
	}
	guarded(() => {
		db.query(
			"INSERT OR IGNORE INTO interact_workflows (owner, workflow_id, created_at) VALUES (?, ?, ?)",
		).run(owner, workflowId, nowIso);
		db.query(
			`INSERT INTO interact_workflow_revisions (owner, workflow_id, revision, format_version,
					digest, skill_ref, catalog_ref, definition_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			owner,
			workflowId,
			revision,
			formatVersion,
			digest,
			skillRef,
			catalogRef,
			definitionJson,
			nowIso,
		);
	});
	const stored = getWorkflowRevision(db, owner, workflowId, revision);
	if (stored === null) throw new InteractStoreError("corrupt_row");
	return stored;
}

/** One revision of this owner's workflow, or `null`. */
export function getWorkflowRevision(
	db: InteractDb,
	owner: string,
	workflowId: string,
	revision: number,
): WorkflowRevision | null {
	requireId(owner, "owner");
	requireId(workflowId, "workflowId");
	requireInteger(revision, "revision", 1);
	const row = guarded(() =>
		db
			.query(
				`SELECT ${COLUMNS} FROM interact_workflow_revisions
				WHERE owner = ? AND workflow_id = ? AND revision = ?`,
			)
			.get(owner, workflowId, revision),
	);
	return row == null ? null : readRevision(row);
}

/** The highest registered revision of a workflow, or `null` when none is registered. */
export function getLatestWorkflowRevision(
	db: InteractDb,
	owner: string,
	workflowId: string,
): WorkflowRevision | null {
	requireId(owner, "owner");
	requireId(workflowId, "workflowId");
	const row = guarded(() =>
		db
			.query(
				`SELECT ${COLUMNS} FROM interact_workflow_revisions
				WHERE owner = ? AND workflow_id = ? ORDER BY revision DESC LIMIT 1`,
			)
			.get(owner, workflowId),
	);
	return row == null ? null : readRevision(row);
}
