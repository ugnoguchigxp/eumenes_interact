import { describe, expect, test } from "bun:test";
import {
	getLatestWorkflowRevision,
	getWorkflowRevision,
	registerWorkflowRevision,
	type WorkflowRevisionInput,
} from "../../src/sqlite/index.ts";
import {
	LATER,
	NOW,
	OWNER_A,
	OWNER_B,
	count,
	openTransaction,
} from "./support.ts";

const REVISION: WorkflowRevisionInput = {
	workflowId: "site-search",
	revision: 1,
	formatVersion: 1,
	digest: "sha256:aaa",
	skillRef: "skill:interact.execute@1",
	catalogRef: "catalog:interact.actions@1",
	definition: {
		formatVersion: 1,
		id: "site-search",
		steps: [{ id: "open", action: "browser.navigate" }],
	},
	nowIso: NOW,
};

describe("workflow revisions", () => {
	test("register and read back", () => {
		const db = openTransaction();
		const stored = registerWorkflowRevision(db, OWNER_A, REVISION);
		expect(stored).toEqual({
			workflowId: "site-search",
			revision: 1,
			formatVersion: 1,
			digest: "sha256:aaa",
			skillRef: "skill:interact.execute@1",
			catalogRef: "catalog:interact.actions@1",
			definition: REVISION.definition,
			createdAt: NOW,
		});
		expect(getWorkflowRevision(db, OWNER_A, "site-search", 1)).toEqual(stored);
		expect(getWorkflowRevision(db, OWNER_A, "site-search", 2)).toBeNull();
	});

	test("registering the identical revision again is a no-op", () => {
		const db = openTransaction();
		const first = registerWorkflowRevision(db, OWNER_A, REVISION);
		const again = registerWorkflowRevision(db, OWNER_A, {
			...REVISION,
			nowIso: LATER,
		});
		expect(again).toEqual(first);
		expect(count(db, "interact_workflow_revisions")).toBe(1);
	});

	test("the same id and revision with a different digest, refs or format is a conflict", () => {
		const db = openTransaction();
		registerWorkflowRevision(db, OWNER_A, REVISION);
		for (const change of [
			{ digest: "sha256:bbb" },
			{ skillRef: "skill:interact.execute@2" },
			{ catalogRef: "catalog:interact.actions@2" },
			{ formatVersion: 2 },
			// Same digest, different body: the digest cannot vouch for a body that differs.
			{
				definition: {
					...REVISION.definition,
					steps: [{ id: "open", action: "browser.back" }],
				},
			},
		]) {
			expect(() =>
				registerWorkflowRevision(db, OWNER_A, { ...REVISION, ...change }),
			).toThrow("revision_conflict");
		}
		expect(getWorkflowRevision(db, OWNER_A, "site-search", 1)?.digest).toBe(
			"sha256:aaa",
		);
	});

	test("key order alone is not a difference", () => {
		const db = openTransaction();
		registerWorkflowRevision(db, OWNER_A, REVISION);
		const reordered = registerWorkflowRevision(db, OWNER_A, {
			...REVISION,
			definition: {
				steps: [{ action: "browser.navigate", id: "open" }],
				id: "site-search",
				formatVersion: 1,
			},
		});
		expect(reordered.digest).toBe("sha256:aaa");
		expect(count(db, "interact_workflow_revisions")).toBe(1);
	});

	test("a published revision cannot be updated even with raw SQL", () => {
		const db = openTransaction();
		registerWorkflowRevision(db, OWNER_A, REVISION);
		expect(() =>
			db.exec("UPDATE interact_workflow_revisions SET digest = 'sha256:evil'"),
		).toThrow("interact_immutable");
	});

	test("a new revision is a new row; latest is the highest", () => {
		const db = openTransaction();
		registerWorkflowRevision(db, OWNER_A, REVISION);
		registerWorkflowRevision(db, OWNER_A, {
			...REVISION,
			revision: 2,
			digest: "sha256:bbb",
		});
		expect(
			getLatestWorkflowRevision(db, OWNER_A, "site-search")?.revision,
		).toBe(2);
		expect(getWorkflowRevision(db, OWNER_A, "site-search", 1)?.digest).toBe(
			"sha256:aaa",
		);
		expect(getLatestWorkflowRevision(db, OWNER_A, "unknown")).toBeNull();
	});

	test("workflows are per owner", () => {
		const db = openTransaction();
		registerWorkflowRevision(db, OWNER_A, REVISION);
		expect(getWorkflowRevision(db, OWNER_B, "site-search", 1)).toBeNull();
		const other = registerWorkflowRevision(db, OWNER_B, {
			...REVISION,
			digest: "sha256:other",
		});
		expect(other.digest).toBe("sha256:other");
		expect(getWorkflowRevision(db, OWNER_A, "site-search", 1)?.digest).toBe(
			"sha256:aaa",
		);
	});

	test("input is validated", () => {
		const db = openTransaction();
		for (const change of [
			{ revision: 0 },
			{ workflowId: "has space" },
			{ digest: "" },
			{ definition: [] as unknown as Record<string, unknown> },
		]) {
			expect(() =>
				registerWorkflowRevision(db, OWNER_A, { ...REVISION, ...change }),
			).toThrow("invalid_input");
		}
	});
});
