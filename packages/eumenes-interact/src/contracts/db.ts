/**
 * The structural SQLite connection the host hands to `eumenes-interact/sqlite` (plan.md §3.4).
 * Same shape as eumenes-memory's `MemoryDb`: `bun:sqlite`'s `Database` satisfies it. The package never
 * imports `bun:sqlite`, never opens files and never sets PRAGMAs; connection, transactions and PRAGMAs
 * belong to the host. Every function of `/sqlite` is synchronous.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface InteractStatement {
	all(...params: SqlValue[]): unknown[];
	/** No row: `null` (bun:sqlite) or `undefined`; both are accepted. */
	get(...params: SqlValue[]): unknown;
	run(...params: SqlValue[]): unknown;
}

export interface InteractDb {
	exec(sql: string): void;
	query(sql: string): InteractStatement;
	/** bun:sqlite's Database has it. Writers refuse to run when it is `false`. */
	readonly inTransaction?: boolean;
}
