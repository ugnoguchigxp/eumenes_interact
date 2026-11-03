import { type Control, createControl, gzipFetch } from "./control.ts";
import {
	type Fetcher,
	LarmError,
	localEndpoint,
	readJson,
	record,
	records,
	string,
} from "./guards.ts";

/** The chat Provider's wire contract in the catalog and in connection records. */
export const LLM_PROTOCOL = "openai.chat-completions.v1";
export const LLM_ENDPOINT = "/v1/chat/completions";

export type LarmChatProfile = { name: string; description?: string };

/**
 * The chat Profiles a user may pick: generally selectable (`selectionPolicy: default`), not deprecated,
 * with an `llm` Provider. Ported from Eumenes `conversationProfile` (`service/index.ts`). The unselected
 * catalog lists every Profile; explicit-only ones serve a named consumer and are left out.
 * Unlike Eumenes there is no saved choice to fall back to: an unreadable catalog is an error.
 */
export async function listLarmChatProfiles(o: {
	baseUrl: string;
	token: string;
	signal: AbortSignal;
	fetch?: Fetcher;
}): Promise<LarmChatProfile[]> {
	if (!o.token.trim()) throw new LarmError("larm_unconfigured");
	const control = createControl({
		base: localEndpoint(o.baseUrl.trim()),
		token: o.token.trim(),
		request: gzipFetch(o.fetch ?? fetch, false),
		lifetime: o.signal,
	});
	const catalog = record(
		await readJson(
			await control(
				"/v3/agent-profiles",
				{ method: "GET", signal: o.signal },
				[200],
			),
			o.signal,
		),
	);
	if (!Array.isArray(catalog.profiles))
		throw new LarmError("larm_catalog_invalid");
	return catalog.profiles.flatMap((item) => {
		const entry = record(item);
		if (entry.selectionPolicy !== "default" || entry.deprecated === true)
			return [];
		if (!records(entry.providers).some((p) => p.name === "llm")) return [];
		if (typeof entry.id !== "string" || !entry.id) return [];
		return [
			{
				name: entry.id,
				...(typeof entry.description === "string" && entry.description
					? { description: entry.description }
					: {}),
			},
		];
	});
}

/** Stage 1: read the selected Profile's catalog and check it matches the contract we speak. */
export async function fetchCatalog(control: Control, profile: string) {
	const catalog = record(
		await readJson(
			await control(
				`/v3/agent-profiles?profile=${encodeURIComponent(profile)}`,
				{ method: "GET" },
				[200],
			),
		),
	);
	if (
		catalog.contractVersion !== "agent-connection.v3" ||
		catalog.requestedProfile !== profile ||
		!Array.isArray(catalog.profiles) ||
		catalog.profiles.length !== 1
	)
		throw new LarmError("larm_catalog_invalid");
	const catalogProfile = record(catalog.profiles[0]);
	const declared = records(catalogProfile.providers).find(
		(p) => p.name === "llm",
	);
	if (
		!declared ||
		declared.protocol !== LLM_PROTOCOL ||
		declared.endpoint !== LLM_ENDPOINT ||
		!declared.model
	)
		throw new LarmError("larm_catalog_provider_missing");
	return {
		catalogRevision: string(catalog.catalogRevision),
		agentProfile: string(catalogProfile.id),
		declared,
	};
}
