import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { InferencePort, LoggerPort } from "eumenes-interact";
import { createLarmInference } from "../inference/index.ts";
import { getSetting } from "./store.ts";
import type { InferenceInfo } from "./types.ts";

/**
 * A LARM inference for one run: the connection and profile are what `larm set` stored, the token comes from
 * the environment on every call and is stored nowhere (plan.md §10.5). Fails before anything starts when the
 * connection is not configured or the token is missing.
 */
export function larmFactory(
	db: Database,
	logger: LoggerPort,
): (correlationId: string) => {
	port: InferencePort;
	info: () => InferenceInfo;
	dispose(): Promise<void>;
} {
	const baseUrl = getSetting(db, "larm.baseUrl");
	const profile = getSetting(db, "larm.profile");
	const token = process.env.LARM_API_TOKEN;
	if (!baseUrl || !profile)
		throw new Error("larm_not_configured: run `larm set` first");
	if (!token) throw new Error("larm_token_missing: set LARM_API_TOKEN");
	return (correlationId) => {
		const inference = createLarmInference({
			settings: { baseUrl, profile },
			token,
			clientId: randomUUID(),
			logger,
			correlationId,
		});
		return {
			port: inference,
			info: () => ({ kind: "larm", ...inference.describe() }),
			dispose: () => inference.close(),
		};
	};
}
