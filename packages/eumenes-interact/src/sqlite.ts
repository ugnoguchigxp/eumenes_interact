/** `eumenes-interact/sqlite`: migrations and store functions on a host-owned connection (plan.md §3.3). */
export type {
	InteractDb,
	InteractStatement,
	SqlValue,
} from "./contracts/db.ts";
export * from "./sqlite/index.ts";
