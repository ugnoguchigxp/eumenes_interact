import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InferencePort, LoggerPort } from "eumenes-interact";
import {
	createClaudeInference,
	DEFAULT_CLAUDE_SETTINGS,
	type ClaudeEffort,
	type ClaudeSettings,
} from "../inference/index.ts";
import type { InferenceInfo } from "./types.ts";

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
			`claude_credential_missing: put ANTHROPIC_API_KEY=<your key> in ${envFile} (the file is gitignored)`,
		);
}

export type ClaudeSession = {
	port: InferencePort;
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
	return {
		port: inference,
		info: () => ({
			kind: "claude",
			...inference.describe(),
			...(settings.maxTokens === undefined
				? {}
				: { maxTokens: settings.maxTokens }),
		}),
		dispose: async () => {},
	};
}
