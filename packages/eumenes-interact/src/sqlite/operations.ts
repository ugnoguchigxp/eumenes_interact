import type { InteractDb } from "../contracts/db.ts";
import {
	OPERATION_STATUSES,
	type AdapterCommand,
	type DeclaredEffect,
	type OperationRequest,
	type OperationStatus,
} from "../contracts/operation.ts";
import {
	assertWritable,
	guarded,
	readBoolean,
	readInteger,
	readJsonValue,
	readNullableText,
	readText,
} from "./db.ts";
import { InteractStoreError } from "./errors.ts";
import { assertNoUnsettledOperation, requireRun } from "./runs.ts";
import {
	invalid,
	listLimit,
	originOfUrl,
	requireCode,
	requireDigest,
	requireId,
	requireInteger,
	requireText,
	requireTimestamp,
	toJson,
} from "./validate.ts";

const DECLARED_EFFECTS: readonly DeclaredEffect[] = [
	"none",
	"navigation",
	"input",
	"submit",
	"unknown",
];

/**
 * Allowed operation transitions (plan.md §5.5). `dispatched` is written before the host awaits the
 * adapter. A refusal before sending ends `not_dispatched` as `failed`; only a dispatched operation can
 * become `confirmed` or `indeterminate`. Settled states never change.
 */
export const OPERATION_TRANSITIONS: Readonly<
	Record<OperationStatus, readonly OperationStatus[]>
> = {
	not_dispatched: ["dispatched", "failed"],
	dispatched: ["confirmed", "failed", "indeterminate"],
	confirmed: [],
	failed: [],
	indeterminate: [],
};

export type SettledStatus = "confirmed" | "failed" | "indeterminate";

export type OperationRecord = {
	operationId: string;
	runId: string;
	seq: number;
	status: OperationStatus;
	action: string;
	sessionId: string;
	generation: number;
	observationRef: string | null;
	targetRef: string | null;
	declaredEffect: DeclaredEffect;
	approvalRef: string | null;
	/** The command as stored: redacted, see `redactCommand`. */
	command: Readonly<Record<string, unknown>>;
	inputDigest: string | null;
	resultCode: string | null;
	retryable: boolean | null;
	createdAt: string;
	dispatchedAt: string | null;
	settledAt: string | null;
};

type Redacted = Record<string, string | number | boolean | null>;

/**
 * What the store keeps of a command (plan.md §14): typed text, select values and wait text become
 * lengths or counts; a URL becomes its origin. Refs and element labels stay (they come from the
 * observation, not from the user's input).
 */
export function redactCommand(command: AdapterCommand): Redacted {
	switch (command.action) {
		case "browser.navigate":
			return { action: command.action, origin: originOfUrl(command.url) };
		case "browser.back":
			return { action: command.action };
		case "page.click":
		case "page.hover":
			return {
				action: command.action,
				targetRef: command.targetRef,
				element: command.element.slice(0, 200),
			};
		case "page.fill":
			return {
				action: command.action,
				targetRef: command.targetRef,
				element: command.element.slice(0, 200),
				textLength: command.text.length,
				submit: command.submit,
			};
		case "page.select":
			return {
				action: command.action,
				targetRef: command.targetRef,
				element: command.element.slice(0, 200),
				valueCount: command.values.length,
			};
		case "page.press":
			// A single character may be typed input; named keys and chords are not.
			return command.key.length > 1
				? { action: command.action, key: command.key.slice(0, 64) }
				: { action: command.action, keyLength: command.key.length };
		case "page.scroll":
			return {
				action: command.action,
				direction: command.direction,
				targetRef: command.targetRef ?? null,
			};
		case "page.wait":
			return {
				action: command.action,
				textLength: command.text?.length ?? null,
				textGoneLength: command.textGone?.length ?? null,
				seconds: command.seconds ?? null,
			};
	}
}

function targetRefOf(command: AdapterCommand): string | null {
	return "targetRef" in command && command.targetRef !== undefined
		? command.targetRef
		: null;
}

const OPERATION_COLUMNS = `operation_id, run_id, seq, status, action, session_id, generation,
	observation_ref, target_ref, declared_effect, approval_ref, command_json, input_digest,
	result_code, retryable, created_at, dispatched_at, settled_at`;

function isOperationStatus(value: string): value is OperationStatus {
	return (OPERATION_STATUSES as readonly string[]).includes(value);
}

function readOperation(row: unknown): OperationRecord {
	const status = readText(row, "status");
	const effect = readText(row, "declared_effect") as DeclaredEffect;
	if (!isOperationStatus(status) || !DECLARED_EFFECTS.includes(effect)) {
		throw new InteractStoreError("corrupt_row");
	}
	const command = readJsonValue(row, "command_json");
	if (typeof command !== "object" || command === null) {
		throw new InteractStoreError("corrupt_row");
	}
	const retryable = (row as Record<string, unknown>)["retryable"];
	return {
		operationId: readText(row, "operation_id"),
		runId: readText(row, "run_id"),
		seq: readInteger(row, "seq"),
		status,
		action: readText(row, "action"),
		sessionId: readText(row, "session_id"),
		generation: readInteger(row, "generation"),
		observationRef: readNullableText(row, "observation_ref"),
		targetRef: readNullableText(row, "target_ref"),
		declaredEffect: effect,
		approvalRef: readNullableText(row, "approval_ref"),
		command: command as Readonly<Record<string, unknown>>,
		inputDigest: readNullableText(row, "input_digest"),
		resultCode: readNullableText(row, "result_code"),
		retryable: retryable === null ? null : readBoolean(row, "retryable"),
		createdAt: readText(row, "created_at"),
		dispatchedAt: readNullableText(row, "dispatched_at"),
		settledAt: readNullableText(row, "settled_at"),
	};
}

/** An operation of this owner's run, or `null`. */
export function getOperation(
	db: InteractDb,
	owner: string,
	operationId: string,
): OperationRecord | null {
	requireId(owner, "owner");
	requireId(operationId, "operationId");
	const row = guarded(() =>
		db
			.query(
				`SELECT ${prefixed("o")} FROM interact_operations o
				JOIN interact_runs r ON r.run_id = o.run_id
				WHERE r.owner = ? AND o.operation_id = ?`,
			)
			.get(owner, operationId),
	);
	return row == null ? null : readOperation(row);
}

function prefixed(alias: string): string {
	return OPERATION_COLUMNS.split(",")
		.map((name) => `${alias}.${name.trim()}`)
		.join(", ");
}

function requireOperation(
	db: InteractDb,
	owner: string,
	operationId: string,
): OperationRecord {
	const operation = getOperation(db, owner, operationId);
	if (operation === null) throw new InteractStoreError("not_found");
	return operation;
}

/**
 * Records the intent to send one operation as `not_dispatched`, numbered after the run's last one.
 * The run must be `running` and have no `dispatched` or `indeterminate` operation (`operation_unsettled`):
 * an unknown operation is never followed by an identical one. `inputDigest` is a host-supplied marker for typed input; the text itself
 * is never stored (see `redactCommand`).
 */
export function recordOperationIntent(
	db: InteractDb,
	owner: string,
	runId: string,
	input: { request: OperationRequest; inputDigest?: string; nowIso: string },
): OperationRecord {
	assertWritable(db);
	const request = input.request;
	const operationId = requireId(request.operationId, "operationId");
	const sessionId = requireText(request.sessionId, "sessionId", 128);
	const generation = requireInteger(request.generation, "generation", 0);
	if (!DECLARED_EFFECTS.includes(request.declaredEffect)) {
		throw invalid("declaredEffect");
	}
	const observationRef =
		request.observationRef === undefined
			? null
			: requireText(request.observationRef, "observationRef", 256);
	const approvalRef =
		request.approvalRef === undefined
			? null
			: requireText(request.approvalRef, "approvalRef", 256);
	const inputDigest =
		input.inputDigest === undefined
			? null
			: requireDigest(input.inputDigest, "inputDigest");
	const nowIso = requireTimestamp(input.nowIso, "nowIso");
	const command = redactCommand(request.command);
	const targetRef = targetRefOf(request.command);
	if (targetRef !== null) requireText(targetRef, "targetRef", 256);

	const run = requireRun(db, owner, runId);
	if (run.status !== "running") throw new InteractStoreError("run_not_running");
	assertNoUnsettledOperation(db, runId);
	const existing = guarded(() =>
		db
			.query("SELECT 1 AS one FROM interact_operations WHERE operation_id = ?")
			.get(operationId),
	);
	if (existing != null) throw new InteractStoreError("already_exists");
	const next = guarded(() =>
		db
			.query(
				"SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM interact_operations WHERE run_id = ?",
			)
			.get(runId),
	);
	guarded(() =>
		db
			.query(
				`INSERT INTO interact_operations (operation_id, run_id, seq, status, action, session_id,
					generation, observation_ref, target_ref, declared_effect, approval_ref, command_json,
					input_digest, created_at)
				VALUES (?, ?, ?, 'not_dispatched', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				operationId,
				runId,
				readInteger(next, "next"),
				request.command.action,
				sessionId,
				generation,
				observationRef,
				targetRef,
				request.declaredEffect,
				approvalRef,
				toJson(command, "command"),
				inputDigest,
				nowIso,
			),
	);
	return requireOperation(db, owner, operationId);
}

/**
 * `not_dispatched` to `dispatched`. The host calls this, inside its transaction and committed, before
 * it awaits the adapter. The run must still be `running`: after a cancel or expiry nothing is sent. Also
 * refused while another operation of the run is `dispatched` or `indeterminate`.
 */
export function markOperationDispatched(
	db: InteractDb,
	owner: string,
	operationId: string,
	nowIso: string,
): OperationRecord {
	assertWritable(db);
	const at = requireTimestamp(nowIso, "nowIso");
	const operation = requireOperation(db, owner, operationId);
	if (!OPERATION_TRANSITIONS[operation.status].includes("dispatched")) {
		throw new InteractStoreError("invalid_transition");
	}
	if (requireRun(db, owner, operation.runId).status !== "running") {
		throw new InteractStoreError("run_not_running");
	}
	assertNoUnsettledOperation(db, operation.runId);
	guarded(() =>
		db
			.query(
				"UPDATE interact_operations SET status = 'dispatched', dispatched_at = ? WHERE operation_id = ? AND status = 'not_dispatched'",
			)
			.run(at, operationId),
	);
	return requireOperation(db, owner, operationId);
}

/**
 * Settles an operation as `confirmed`, `failed` or `indeterminate`. Only a `dispatched` operation can
 * be confirmed or indeterminate; `not_dispatched` can only become `failed` (refused before sending).
 * An indeterminate operation is never retryable. Allowed on a finished run: the fact is still recorded.
 */
export function settleOperation(
	db: InteractDb,
	owner: string,
	operationId: string,
	input: {
		status: SettledStatus;
		code?: string;
		retryable: boolean;
		nowIso: string;
	},
): OperationRecord {
	assertWritable(db);
	const at = requireTimestamp(input.nowIso, "nowIso");
	const code =
		input.code === undefined ? null : requireCode(input.code, "code");
	if (!["confirmed", "failed", "indeterminate"].includes(input.status)) {
		throw invalid("status");
	}
	if (typeof input.retryable !== "boolean") throw invalid("retryable");
	if (input.status === "indeterminate" && input.retryable) {
		throw invalid("retryable");
	}
	const operation = requireOperation(db, owner, operationId);
	if (!OPERATION_TRANSITIONS[operation.status].includes(input.status)) {
		throw new InteractStoreError("invalid_transition");
	}
	guarded(() =>
		db
			.query(
				"UPDATE interact_operations SET status = ?, result_code = ?, retryable = ?, settled_at = ? WHERE operation_id = ? AND status = ?",
			)
			.run(
				input.status,
				code,
				input.retryable ? 1 : 0,
				at,
				operationId,
				operation.status,
			),
	);
	return requireOperation(db, owner, operationId);
}

/** The operations of a run in order. */
export function listOperations(
	db: InteractDb,
	owner: string,
	runId: string,
): OperationRecord[] {
	requireRun(db, owner, runId);
	const rows = guarded(() =>
		db
			.query(
				`SELECT ${OPERATION_COLUMNS} FROM interact_operations WHERE run_id = ? ORDER BY seq`,
			)
			.all(runId),
	);
	return rows.map((row) => readOperation(row));
}

/**
 * Operations a restart must reconcile: `dispatched` (outcome unknown, the process died or the host
 * lost the reply) and `indeterminate`. This only reports. Nothing here, and nothing the host does with
 * the result, may send the command again (plan.md §9); the host asks the platform for its state or
 * settles `dispatched` as `indeterminate`. `not_dispatched` intents were never sent and are not listed.
 */
export function listUnsettledOperations(
	db: InteractDb,
	owner: string,
	options: { limit?: number } = {},
): OperationRecord[] {
	requireId(owner, "owner");
	const rows = guarded(() =>
		db
			.query(
				`SELECT ${prefixed("o")} FROM interact_operations o
				JOIN interact_runs r ON r.run_id = o.run_id
				WHERE r.owner = ? AND o.status IN ('dispatched', 'indeterminate')
				ORDER BY o.created_at, o.operation_id LIMIT ?`,
			)
			.all(owner, listLimit(options.limit)),
	);
	return rows.map((row) => readOperation(row));
}
