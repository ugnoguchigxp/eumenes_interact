import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { InferencePort, InferenceUsage } from "eumenes-interact";

export type PaidModel = "claude-haiku-5-5" | "gpt-6-luna";
// Conservative long-context rates, including the most expensive cache-write rate.
// Sources and verification date: docs/reviews/2026-11-05/api-evaluation-plan.json.
const RATE = {
	"claude-haiku-5-5": { input: 0.625, output: 2.5 },
	"gpt-6-luna": { input: 0.5, output: 0.75 },
} as const;
// Official maxima checked 2026-11-05. Unknown calls retain these full bounds.
// platform.claude.com/docs/en/models/haiku-5-5/overview (1M context)
// developers.openai.com/api/docs/models/gpt-6-luna (922K max input)
const MAX_INPUT = {
	"claude-haiku-5-5": 1_000_000,
	"gpt-6-luna": 922_000,
} as const;
const micros = (usd: number) => Math.ceil(usd * 1_000_000);
const valid = (n: unknown): n is number =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Durable, shared reservation ledger. A process crash or unknown usage retains the whole reservation. */
export class SpendLedger {
	private readonly db: Database;
	constructor(
		path: string,
		readonly limitUsd: number,
		readonly maxAttempts = 600,
	) {
		if (
			!(limitUsd > 0 && limitUsd <= 10) ||
			!Number.isSafeInteger(maxAttempts) ||
			maxAttempts < 1
		)
			throw new Error("invalid_spend_limit");
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new Database(path);
		this.db.exec(
			"PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS spend_config (id INTEGER PRIMARY KEY CHECK(id=1), cap INTEGER NOT NULL, attempts INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS spend_calls (id TEXT PRIMARY KEY, model TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER, state TEXT NOT NULL, at TEXT NOT NULL)",
		);
		this.db
			.transaction(() => {
				this.db
					.query("INSERT OR IGNORE INTO spend_config VALUES(1, ?, ?)")
					.run(micros(limitUsd), maxAttempts);
				const config = this.db
					.query("SELECT cap, attempts FROM spend_config WHERE id=1")
					.get() as { cap: number; attempts: number };
				if (config.cap !== micros(limitUsd) || config.attempts !== maxAttempts)
					throw new Error("spend_config_mismatch");
			})
			.immediate();
	}

	summary() {
		const row = this.db
			.query(
				"SELECT COUNT(*) AS attempts, COALESCE(SUM(COALESCE(charged,reserved)),0) AS accounted, COALESCE(SUM(state != 'settled'),0) AS unknown FROM spend_calls",
			)
			.get() as { attempts: number; accounted: number; unknown: number };
		return {
			limitUsd: this.limitUsd,
			maxAttempts: this.maxAttempts,
			attempts: row.attempts,
			accountedUpperUsd: row.accounted / 1_000_000,
			unknownCalls: row.unknown,
		};
	}

	reserve(model: PaidModel, maxOutputTokens: number): string {
		if (
			!Object.hasOwn(RATE, model) ||
			!valid(maxOutputTokens) ||
			maxOutputTokens < 1 ||
			maxOutputTokens > 64_000
		)
			throw new Error("unpriced_request");
		// Reserve the entire official input/context maximum, regardless of the actual small prompt.
		// This deliberately avoids relying on heuristic character/token ratios before sending.
		const amount = micros(
			(MAX_INPUT[model] * RATE[model].input +
				maxOutputTokens * RATE[model].output) /
				1_000_000,
		);
		return this.db
			.transaction(() => {
				const s = this.summary();
				if (
					s.attempts >= this.maxAttempts ||
					micros(s.accountedUpperUsd) + amount > micros(this.limitUsd)
				)
					throw new Error("spend_exhausted");
				const id = randomUUID();
				this.db
					.query("INSERT INTO spend_calls VALUES(?,?,?,NULL,'reserved',?)")
					.run(id, model, amount, new Date().toISOString());
				return id;
			})
			.immediate();
	}

	settle(id: string, model: PaidModel, usage: InferenceUsage) {
		const values = [
			usage.inputTokens,
			usage.outputTokens,
			usage.cacheReadInputTokens,
			usage.cacheCreationInputTokens,
		];
		if (!values.every(valid)) return; // Unknown is never free.
		const [input, output, read, write] = values as number[];
		const upper = micros(
			((input! + read! + write!) * RATE[model].input +
				output! * RATE[model].output) /
				1_000_000,
		);
		const row = this.db
			.query(
				"SELECT reserved FROM spend_calls WHERE id=? AND model=? AND state='reserved'",
			)
			.get(id, model) as { reserved: number } | null;
		if (!row) throw new Error("spend_reservation_missing");
		if (upper > row.reserved) throw new Error("spend_bound_violated");
		this.db
			.query(
				"UPDATE spend_calls SET charged=?,state='settled' WHERE id=? AND state='reserved'",
			)
			.run(upper, id);
	}
	close() {
		this.db.close();
	}

	/** Tighten only obsolete 2M-input reservations using the providers' documented physical maxima.
	 * No usage is invented; unknown calls remain unknown and the original bounds remain in the audit table.
	 */
	reconcileLegacyBounds() {
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS spend_bound_audit (id TEXT PRIMARY KEY, old_bound INTEGER NOT NULL, new_bound INTEGER NOT NULL, basis TEXT NOT NULL, at TEXT NOT NULL)",
		);
		return this.db
			.transaction(() => {
				let changed = 0;
				const rows = this.db
					.query(
						"SELECT id,model,reserved FROM spend_calls WHERE state='reserved'",
					)
					.all() as { id: string; model: PaidModel; reserved: number }[];
				for (const row of rows) {
					const rates = RATE[row.model];
					const legacyInput = micros(2 * rates.input);
					if (row.reserved <= legacyInput) continue;
					const outputCap =
						Math.ceil((row.reserved - legacyInput) / rates.output) + 1;
					if (outputCap > 64_001) continue;
					const bound = micros(
						(MAX_INPUT[row.model] * rates.input + outputCap * rates.output) /
							1_000_000,
					);
					if (bound >= row.reserved) continue;
					this.db
						.query("INSERT OR IGNORE INTO spend_bound_audit VALUES(?,?,?,?,?)")
						.run(
							row.id,
							row.reserved,
							bound,
							"official model max input/context, same original token rates; 2026-11-05",
							new Date().toISOString(),
						);
					this.db
						.query(
							"UPDATE spend_calls SET reserved=? WHERE id=? AND state='reserved'",
						)
						.run(bound, row.id);
					changed++;
				}
				return changed;
			})
			.immediate();
	}
}

/** Wrap the raw provider port, below plan, choice, summary and browser adapters. No hidden retries. */
export function budgetedInference(
	inner: InferencePort,
	ledger: SpendLedger,
	model: PaidModel,
): InferencePort {
	return {
		async complete(request) {
			request.signal.throwIfAborted();
			const id = ledger.reserve(model, request.maxOutputTokens);
			const outcome = await inner.complete(request);
			ledger.settle(id, model, outcome.usage);
			return outcome;
		},
	};
}
