import type { InteractDb } from "../contracts/db.ts";
import { InteractStoreError } from "./errors.ts";

/**
 * Common parts of the store functions. Nothing here opens a connection, starts a transaction or sets a
 * PRAGMA: those belong to the host. Foreign keys are only enforced when the host turned them on; the
 * functions check ownership themselves and do not rely on that.
 */

/** Turns SQLite failures with a fixed meaning into store errors; anything else passes through. */
export function translateSqliteError(error: unknown): unknown {
	if (error instanceof InteractStoreError) return error;
	if (!(error instanceof Error)) return error;
	const code = (error as unknown as Record<string, unknown>)["code"];
	if (
		(typeof code === "string" && code.startsWith("SQLITE_READONLY")) ||
		error.message.includes("attempt to write a readonly database")
	) {
		return new InteractStoreError("readonly_connection");
	}
	if (error.message.includes("interact_immutable")) {
		return new InteractStoreError("immutable");
	}
	if (error.message.includes("no such table: interact_")) {
		return new InteractStoreError("schema_missing");
	}
	return error;
}

export function guarded<T>(operation: () => T): T {
	try {
		return operation();
	} catch (error) {
		throw translateSqliteError(error);
	}
}

/** Entry check of every writer: the host's transaction must be open. */
export function assertWritable(db: InteractDb): void {
	if (db.inTransaction === false) {
		throw new InteractStoreError("not_in_transaction");
	}
}

// Rows arrive as `unknown`; each column is checked on the way out.

export function readRow(row: unknown): Readonly<Record<string, unknown>> {
	if (typeof row !== "object" || row === null || Array.isArray(row)) {
		throw new InteractStoreError("corrupt_row");
	}
	return row as Readonly<Record<string, unknown>>;
}

function column(row: unknown, name: string): unknown {
	const record = readRow(row);
	if (!Object.hasOwn(record, name)) throw new InteractStoreError("corrupt_row");
	return record[name];
}

export function readInteger(row: unknown, name: string): number {
	const value = column(row, name);
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (
		typeof value === "bigint" &&
		value >= BigInt(Number.MIN_SAFE_INTEGER) &&
		value <= BigInt(Number.MAX_SAFE_INTEGER)
	) {
		return Number(value);
	}
	throw new InteractStoreError("corrupt_row");
}

export function readText(row: unknown, name: string): string {
	const value = column(row, name);
	if (typeof value !== "string") throw new InteractStoreError("corrupt_row");
	return value;
}

export function readNullableText(row: unknown, name: string): string | null {
	const value = column(row, name);
	if (value === null) return null;
	if (typeof value !== "string") throw new InteractStoreError("corrupt_row");
	return value;
}

export function readNullableInteger(row: unknown, name: string): number | null {
	return column(row, name) === null ? null : readInteger(row, name);
}

export function readBoolean(row: unknown, name: string): boolean {
	const value = readInteger(row, name);
	if (value !== 0 && value !== 1) throw new InteractStoreError("corrupt_row");
	return value === 1;
}

/** A stored JSON column of any shape. */
export function readJsonValue(row: unknown, name: string): unknown {
	try {
		return JSON.parse(readText(row, name));
	} catch {
		throw new InteractStoreError("corrupt_row");
	}
}

/** A stored JSON column; `check` narrows it or the row is corrupt. */
export function readJson<T>(
	row: unknown,
	name: string,
	check: (value: unknown) => value is T,
): T {
	const value = readJsonValue(row, name);
	if (!check(value)) throw new InteractStoreError("corrupt_row");
	return value;
}

export function isRecord(
	value: unknown,
): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
