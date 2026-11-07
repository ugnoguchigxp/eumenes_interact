import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InferencePort, LoggerPort } from "eumenes-interact";
import {
	createClaudeInference,
	DEFAULT_CLAUDE_SETTINGS,
	type ClaudeEffort,
	type ClaudeSettings,
} from "../inference/index.ts";
import { asCollabAgent } from "./collab.ts";
import type { InferenceInfo } from "./types.ts";
import { SpendLedger, budgetedInference } from "../inference/spend.ts";
import { createOpenAIInference, LUNA_MODEL } from "../inference/openai.ts";
import { silentLabLogger } from "./log.ts";

export function paidLedger() {
	return new SpendLedger(
		process.env.LAB_SPEND_DB ??
			fileURLToPath(new URL("../data/api-spend.sqlite", import.meta.url)),
		Number(process.env.LAB_SPEND_LIMIT_USD ?? 15),
		Number(process.env.LAB_SPEND_MAX_ATTEMPTS ?? 796),
	);
}

/**
 * Choosing and starting the Claude inference (plan.md §10.5): the model and the effort are frozen per run like
 * the other conditions, and the key comes from the environment, never from an option, a file of the lab or a
 * log. Bun loads `<repo>/.env` when it is started from the repository root; the check below also reads that
 * file when the process started elsewhere.
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const REPO_ENV = fileURLToPath(new URL("../../.env", import.meta.url));

export function parseEffort(value: string | undefined): ClaudeEffort {
	if (value === undefined) return DEFAULT_CLAUDE_SETTINGS.effort;
	if ((EFFORTS as readonly string[]).includes(value))
		return value as ClaudeEffort;
	throw new Error(`invalid_effort:${value} (one of ${EFFORTS.join(", ")})`);
}

export function parseModel(value: string | undefined): string {
	if (value === undefined) return DEFAULT_CLAUDE_SETTINGS.model;
	if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)) return value;
	throw new Error("invalid_model");
}

/** `--max-tokens`: the output bound of one call (Claude only); recorded with the run's other conditions. */
export function parseMaxTokens(
	value: string | number | undefined,
): number | undefined {
	if (value === undefined) return undefined;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(n) || n < 256 || n > 64_000)
		throw new Error("invalid_max_tokens (256 to 64000)");
	return n;
}

export const claudeSettings = (flags: {
	model?: string | undefined;
	effort?: string | undefined;
	maxTokens?: string | number | undefined;
}): ClaudeSettings => {
	const maxTokens = parseMaxTokens(flags.maxTokens);
	return {
		model: parseModel(flags.model),
		effort: parseEffort(flags.effort),
		...(maxTokens === undefined ? {} : { maxTokens }),
	};
};

const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** `KEY=value` lines of a dotenv file; quotes around a value are dropped, comments and blanks are not lines. */
export function parseDotenv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(
			raw,
		);
		if (!m || raw.trimStart().startsWith("#")) continue;
		const value = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
		out[m[1]!] = value;
	}
	return out;
}

const has = (env: Record<string, string | undefined>) =>
	KEYS.some((key) => (env[key] ?? "") !== "");

/**
 * Fails fast, before anything is opened, when no credential is available. Reads `env` (default: the process
 * environment) and, if it has none, the repository's `.env` into it. The message names where to put the key
 * and never contains it.
 */
export function ensureClaudeCredential(
	env: Record<string, string | undefined> = process.env,
	envFile: string = REPO_ENV,
): void {
	if (!env.ANTHROPIC_API_KEY && env.CLAUDE_API_KEY)
		env.ANTHROPIC_API_KEY = env.CLAUDE_API_KEY;
	if (has(env)) return;
	try {
		const file = parseDotenv(readFileSync(envFile, "utf8"));
		for (const key of KEYS)
			if ((file[key] ?? "") !== "" && (env[key] ?? "") === "")
				env[key] = file[key];
	} catch {
		// No file: the message below says where it belongs.
	}
	if (!has(env))
		throw new Error(
			"claude_credential_missing: export ANTHROPIC_API_KEY or CLAUDE_API_KEY in your login shell",
		);
}

export type ClaudeSession = {
	port: InferencePort;
	raw: InferencePort;
	info: () => InferenceInfo;
	dispose(): Promise<void>;
};

/** A Claude inference for one run. The settings are fixed here, for the whole run. */
export function startClaude(
	settings: ClaudeSettings,
	logger: LoggerPort,
	correlationId: string,
): ClaudeSession {
	const inference = createClaudeInference({ settings, logger, correlationId });
	if (settings.model !== "claude-haiku-5-5") throw new Error("unpriced_model");
	const other = createOpenAIInference(lunaSettings({}));
	const ledger = paidLedger();
	const raw = budgetedInference(inference, ledger, settings.model);
	const reviewLuna = budgetedInference(other, ledger, LUNA_MODEL);
	return {
		port: asCollabAgent(raw, { completionVerifiers: [raw, reviewLuna] }),
		raw,
		info: () => ({
			kind: "claude",
			completionReview: "dual",
			...inference.describe(),
			...(settings.maxTokens === undefined
				? {}
				: { maxTokens: settings.maxTokens }),
		}),
		dispose: async () => {
			ledger.close();
		},
	};
}

export function lunaSettings(flags: {
	model?: string;
	effort?: string;
	maxTokens?: string | number;
}) {
	if (flags.model !== undefined && flags.model !== LUNA_MODEL)
		throw new Error("luna_model_required");
	const effort = flags.effort ?? "low";
	if (!["none", ...EFFORTS].includes(effort)) throw new Error("invalid_effort");
	return {
		model: LUNA_MODEL,
		effort: effort as "none" | ClaudeEffort,
		maxTokens: parseMaxTokens(flags.maxTokens),
	};
}
export function startLuna(settings = lunaSettings({})): ClaudeSession {
	ensureClaudeCredential();
	const inner = createOpenAIInference(settings);
	const other = createClaudeInference({
		settings: { model: "claude-haiku-5-5", effort: "low" },
		logger: silentLabLogger,
		correlationId: "completion-review",
	});
	const ledger = paidLedger();
	const raw = budgetedInference(inner, ledger, LUNA_MODEL);
	const reviewClaude = budgetedInference(other, ledger, "claude-haiku-5-5");
	return {
		port: asCollabAgent(raw, { completionVerifiers: [reviewClaude, raw] }),
		raw,
		info: () => ({
			kind: "openai",
			completionReview: "dual",
			provider: "openai",
			model: LUNA_MODEL,
			effort: settings.effort,
		}),
		dispose: async () => {
			ledger.close();
		},
	};
}
