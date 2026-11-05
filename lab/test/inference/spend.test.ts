import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger, budgetedInference } from "../../inference/spend.ts";
import { Database } from "bun:sqlite";

test("legacy bounds can tighten to official model maxima without inventing usage or erasing the old bound", () => {
	const dir = mkdtempSync(join(tmpdir(), "spend-bounds-"));
	const path = join(dir, "spend.sqlite");
	const ledger = new SpendLedger(path, 10);
	const db = new Database(path);
	try {
		db.query(
			"INSERT INTO spend_calls VALUES('legacy','claude-haiku-5-5',1255120,NULL,'reserved','2026-11-05')",
		).run();
		expect(ledger.reconcileLegacyBounds()).toBe(1);
		expect(ledger.summary().unknownCalls).toBe(1);
		expect(ledger.summary().accountedUpperUsd).toBeGreaterThan(0.63012);
		expect(
			db
				.query("SELECT old_bound FROM spend_bound_audit WHERE id='legacy'")
				.get(),
		).toEqual({ old_bound: 1255120 });
		expect(ledger.reconcileLegacyBounds()).toBe(0);
	} finally {
		db.close();
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("shared provider reservations persist across reopening, unknown usage consumes the reservation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spend-"));
	const path = join(dir, "spend.sqlite");
	let ledger = new SpendLedger(path, 1.4);
	try {
		ledger.reserve("claude-haiku-5-5", 1000);
		ledger.close();
		ledger = new SpendLedger(path, 1.4);
		ledger.reserve("gpt-6-luna", 1000);
		expect(ledger.summary().attempts).toBe(2);
		expect(ledger.summary().unknownCalls).toBe(2);
		let sent = 0;
		const port = budgetedInference(
			{
				complete: async () => {
					sent++;
					throw new Error("should not send");
				},
			},
			ledger,
			"gpt-6-luna",
		);
		await expect(
			port.complete({
				messages: [],
				maxOutputTokens: 1000,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("spend_exhausted");
		expect(sent).toBe(0);
		expect(() => new SpendLedger(path, 4)).toThrow("spend_config_mismatch");
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settled usage releases only the unused reservation; duplicate settlement and excess usage are rejected", () => {
	const ledger = new SpendLedger(":memory:", 10);
	try {
		const id = ledger.reserve("claude-haiku-5-5", 1000);
		const usage = {
			inputTokens: 100,
			outputTokens: 200,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		};
		ledger.settle(id, "claude-haiku-5-5", usage);
		expect(ledger.summary().accountedUpperUsd).toBeLessThan(0.001);
		expect(() => ledger.settle(id, "claude-haiku-5-5", usage)).toThrow(
			"spend_reservation_missing",
		);
		const second = ledger.reserve("gpt-6-luna", 1000);
		ledger.settle(second, "gpt-6-luna", { ...usage, inputTokens: null });
		expect(ledger.summary().unknownCalls).toBe(1);
		expect(() =>
			ledger.settle(second, "gpt-6-luna", {
				...usage,
				outputTokens: 10_000_000,
			}),
		).toThrow("spend_bound_violated");
	} finally {
		ledger.close();
	}
});

test("simultaneous connections cannot reserve the same remaining dollars", () => {
	const dir = mkdtempSync(join(tmpdir(), "spend-concurrent-"));
	const a = new SpendLedger(join(dir, "spend.sqlite"), 0.8);
	const b = new SpendLedger(join(dir, "spend.sqlite"), 0.8);
	try {
		a.reserve("gpt-6-luna", 1000);
		expect(() => b.reserve("gpt-6-luna", 1000)).toThrow("spend_exhausted");
		expect(b.summary().attempts).toBe(1);
	} finally {
		a.close();
		b.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
