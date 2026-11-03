import { LLM_ENDPOINT, LLM_PROTOCOL, fetchCatalog } from "./catalog.ts";
import type { Control } from "./control.ts";
import {
	LarmError,
	providerEndpoint,
	readJson,
	record,
	records,
	string,
	wait,
} from "./guards.ts";

/**
 * One chat session's LARM connection, as Eumenes' `sessionRole: "subagent"` path holds it: one Connection
 * for the LLM Provider alone, no requested capacity, a claimed capacity that must be the sub role's.
 * Ported from Eumenes `api/domains/larm/service/` `connect.ts`, `establish.ts`, `refresh.ts`,
 * `agent-capacity.ts`, `context-capacity.ts`, `claimability.ts` and `lease-manager.ts`. Calls are
 * serialized by the caller, so there is no use count and no background timer: the lease is renewed
 * when a call finds it close to expiry.
 */

/** The context window of a sub-role connection (Eumenes `assertAgentCapacity`). */
const SUB_CONTEXT_TOKENS = 131_072;
const AUDIENCE = "saaa-desktop";
const TTL_SECONDS = 900;
const RENEW_MARGIN_MS = 180_000;
/** Time one preparation (catalog, create, ready, claim, renew) may take. */
const PREPARE_MS = 60_000;
/** Claims of a ready connection LARM refuses (409) before the error is final, one second apart. */
const CLAIM_ATTEMPTS = 60;
const TERMINAL = ["expired", "released"];

type Rec = Record<string, unknown>;

export type Provider = {
	baseUrl: string;
	/** Exact inference URL verified from the claim. */
	endpoint?: string;
	model: string;
	token: string;
	contextWindow: {
		maxTokens: number;
		outputReserveTokens: number;
		/** Explicit newer contract: the reserve is a default, not an upper bound. */
		outputLimit?: "remaining-context";
		safetyMarginTokens: number;
	};
};

export type Lease = {
	id: string;
	bootEpoch?: string;
	agentProfile: string;
	/** The earlier of the connection's and the credential's expiry. */
	expiresAt: number;
	provider: Provider;
	closing: boolean;
	/** Coalesces cleanup; kept after a confirmed release. */
	release?: Promise<void>;
};

const llmOf = (value: Rec) =>
	records(value.providers).find((p) => p.name === "llm");

function assertSubCapacity(info: Rec) {
	if (record(info.contextWindow).maxTokens !== SUB_CONTEXT_TOKENS)
		throw new LarmError("larm_agent_context_mismatch");
}

/** The catalog capacity is an upper bound; the claim is the allocated window. No capacity is requested. */
function assertClaimContextWindow(declared: Rec, announced: Rec, claimed: Rec) {
	const maximum = record(declared.contextWindow);
	const actual = record(claimed.contextWindow);
	const ready = record(announced.contextWindow ?? {});
	const positive = (value: unknown): value is number =>
		typeof value === "number" && Number.isSafeInteger(value) && value > 0;
	if (
		!positive(maximum.maxTokens) ||
		!positive(actual.maxTokens) ||
		actual.maxTokens > maximum.maxTokens ||
		(announced.contextWindow !== undefined &&
			(!positive(ready.maxTokens) || ready.maxTokens !== actual.maxTokens)) ||
		Object.entries(maximum).some(
			([key, value]) => key !== "maxTokens" && actual[key] !== value,
		)
	)
		throw new LarmError("larm_claim_context_mismatch");
}

/** Provider credentials may expire before the connection lease. */
function claimExpiry(claim: Rec) {
	const expiry = Date.parse(string(claim.expiresAt));
	return Math.min(
		expiry,
		...records(claim.providers).flatMap((provider) => {
			const credential = record(provider.credential);
			return credential.expiresAt === undefined
				? []
				: [Date.parse(string(credential.expiresAt))];
		}),
	);
}

/** A ready connection's claimable flag is a short-lived cache, refreshed by the health API. */
async function refreshClaimability(control: Control, id: string, p: Rec) {
	const response = await control(
		`/v1/agent-connections/${encodeURIComponent(id)}/providers/llm/health`,
		{ method: "GET" },
		[200, 503],
	);
	const health = record(await readJson(response));
	if (
		health.name !== "llm" ||
		(p.capability !== undefined && health.capability !== p.capability) ||
		typeof health.ready !== "boolean" ||
		typeof health.acceptingRequests !== "boolean" ||
		(response.status === 200) !== health.ready
	)
		throw new LarmError("larm_invalid_provider_health");
	return health.ready ? 0 : 1000;
}

type Hooks = {
	base: URL;
	profile: string;
	client: string;
	/** Not bound to the caller's signal: the cleanup DELETE must run after a cancellation. */
	control: Control;
	/** Aborted when the session closes. */
	lifetime: AbortSignal;
	log: (
		name: "connected" | "released",
		fields: { code?: string; durationMs?: number },
	) => void;
};

export function createConnection({
	base,
	profile,
	client,
	control,
	lifetime,
	log,
}: Hooks) {
	let lease: Lease | undefined;
	let model: string | null = null;

	async function createRecord(
		scoped: Control,
		revision: string,
		idempotencyKey: string,
	) {
		const response = await scoped(
			"/v1/agent-connections",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": idempotencyKey,
					Prefer: "wait=1",
				},
				body: JSON.stringify({
					profile,
					client,
					audience: AUDIENCE,
					ttlSeconds: TTL_SECONDS,
					allowFallback: false,
					deploymentPolicy: "existing-only",
					providers: ["llm"],
					expectedCatalogRevision: revision,
				}),
			},
			[201, 202],
		);
		const created = record(await readJson(response));
		const id = string(created.id);
		if (!/^[A-Za-z0-9_-]{1,160}$/.test(id))
			throw new LarmError("larm_invalid_connection_id");
		return { id, created };
	}

	/** Waits until the Provider is ready and claimable. */
	async function awaitReady(
		scoped: Control,
		signal: AbortSignal,
		input: { id: string; created: Rec; agentProfile: string },
	): Promise<Rec> {
		let { created } = input;
		const check = () => {
			if (created.id !== input.id)
				throw new LarmError("larm_invalid_connection");
			if (TERMINAL.includes(String(created.status)))
				throw new LarmError(`larm_connection_${created.status}`);
			if (
				created.profile !== profile ||
				created.agentProfile !== input.agentProfile ||
				!Array.isArray(created.providers)
			)
				throw new LarmError("larm_invalid_connection");
			const p = llmOf(created);
			if (!p) throw new LarmError("larm_catalog_provider_missing");
			if (["failed", "expired", "released"].includes(String(p.readiness)))
				throw new LarmError("larm_provider_failed");
			if (
				p.readiness === "ready" &&
				(p.protocol !== LLM_PROTOCOL || p.endpoint !== LLM_ENDPOINT)
			)
				throw new LarmError("larm_provider_not_ready");
			if (p.readiness === "ready") assertSubCapacity(p);
			return (
				p.readiness === "ready" &&
				created.status === "ready" &&
				p.claimable === true
			);
		};
		while (!check()) {
			const p = llmOf(created)!;
			const stale = created.status === "ready" && p.readiness === "ready";
			await wait(
				stale ? await refreshClaimability(scoped, input.id, p) : 100,
				signal,
			);
			created = record(
				await readJson(
					await scoped(
						`/v1/agent-connections/${input.id}`,
						{ method: "GET" },
						[200],
					),
				),
			);
		}
		return created;
	}

	/** Reads the Provider out of a claim and checks it against the contract. */
	function claimedProvider(info: Rec): Provider {
		const fields = record(record(info.configuration).fields);
		const baseUrl = string(fields.baseURL);
		providerEndpoint(baseUrl, base);
		let endpoint: string | undefined;
		if (info.endpoint !== undefined) {
			const url = providerEndpoint(string(info.endpoint), base);
			const expected = new URL(
				LLM_ENDPOINT.replace(/^\/v1\//, ""),
				`${baseUrl.replace(/\/$/, "")}/`,
			);
			if (url.href !== expected.href)
				throw new LarmError("larm_claim_endpoint_mismatch");
			endpoint = url.href;
		}
		if (fields.model !== info.model)
			throw new LarmError("larm_claim_configuration_mismatch");
		const contextWindow = record(info.contextWindow);
		if (
			!["maxTokens", "outputReserveTokens", "safetyMarginTokens"].every(
				(key) =>
					Number.isInteger(contextWindow[key]) &&
					Number(contextWindow[key]) > 0,
			) ||
			(contextWindow.outputLimit !== undefined &&
				contextWindow.outputLimit !== "remaining-context")
		)
			throw new LarmError("larm_invalid_context_window");
		return {
			baseUrl,
			endpoint,
			model: string(info.model),
			token: string(record(info.credential).token),
			contextWindow: contextWindow as Provider["contextWindow"],
		};
	}

	const claimRequest = (id: string, scoped: Control) =>
		scoped(
			`/v1/agent-connections/${id}/claim`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					format: "openai-provider-v1",
					providers: ["llm"],
				}),
			},
			[200],
		);

	/** Stage 4: claim the credential and turn it into a validated Provider. */
	async function claim(
		scoped: Control,
		input: { id: string; created: Rec; declared: Rec },
	) {
		const claimed = record(
			await readJson(await claimRequest(input.id, scoped)),
		);
		if (
			claimed.id !== input.id ||
			claimed.status !== "ready" ||
			!Array.isArray(claimed.providers)
		)
			throw new LarmError("larm_invalid_claim");
		const expiresAt = claimExpiry(claimed);
		if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 30_000)
			throw new LarmError("larm_expired");
		const info = llmOf(claimed);
		const announced = llmOf(input.created);
		if (
			!info ||
			!announced ||
			info.protocol !== LLM_PROTOCOL ||
			info.model !== announced.model ||
			info.model !== input.declared.model
		)
			throw new LarmError("larm_claim_mismatch");
		assertSubCapacity(announced);
		assertSubCapacity(info);
		assertClaimContextWindow(input.declared, announced, info);
		return { expiresAt, provider: claimedProvider(info) };
	}

	/**
	 * Creates the connection and claims it. A connection that cannot be claimed is released before the
	 * error is thrown.
	 */
	async function establish(signal: AbortSignal): Promise<Lease> {
		const scoped: Control = (path, init, accepted) =>
			control(path, { ...init, signal }, accepted);
		const started = performance.now();
		const { catalogRevision, agentProfile, declared } = await fetchCatalog(
			scoped,
			profile,
		);
		// One key per establish: every attempt to create this connection reuses it.
		const idempotencyKey = crypto.randomUUID();
		let result: Awaited<ReturnType<typeof createRecord>>;
		try {
			result = await createRecord(scoped, catalogRevision, idempotencyKey);
		} catch (error) {
			// A timed-out POST may still have created the connection; the same key makes one retry
			// return it instead of a duplicate.
			if (
				!(error instanceof DOMException && error.name === "TimeoutError") ||
				signal.aborted ||
				lifetime.aborted
			)
				throw error;
			result = await createRecord(scoped, catalogRevision, idempotencyKey);
		}
		const { id, created } = result;
		try {
			let ready = await awaitReady(scoped, signal, {
				id,
				created,
				agentProfile,
			});
			let claimed: Awaited<ReturnType<typeof claim>>;
			for (let attempt = 1; ; attempt++) {
				try {
					claimed = await claim(scoped, { id, created: ready, declared });
					break;
				} catch (error) {
					// Ready but not yet claimable (a profile switch): LARM refuses the claim; wait and look again.
					if (
						!(
							error instanceof LarmError && error.code === "larm_control_409"
						) ||
						attempt >= CLAIM_ATTEMPTS
					)
						throw error;
					await wait(1000, signal);
					ready = await awaitReady(scoped, signal, {
						id,
						created: ready,
						agentProfile,
					});
				}
			}
			signal.throwIfAborted();
			lifetime.throwIfAborted();
			model = claimed.provider.model;
			log("connected", { durationMs: Math.round(performance.now() - started) });
			return {
				id,
				bootEpoch:
					typeof created.bootEpoch === "string" ? created.bootEpoch : undefined,
				agentProfile,
				expiresAt: claimed.expiresAt,
				provider: claimed.provider,
				closing: false,
			};
		} catch (error) {
			try {
				await control(
					`/v1/agent-connections/${id}`,
					{ method: "DELETE" },
					[204, 200],
				);
			} catch {
				/* original error is primary */
			}
			throw error;
		}
	}

	/** Renews the lease and re-claims the credential, checking nothing about the contract changed. */
	async function renew(
		scoped: Control,
		current: Lease,
	): Promise<{ expiresAt: number; provider: Provider }> {
		const renewed = record(
			await readJson(
				await scoped(
					`/v1/agent-connections/${current.id}/renew`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"Idempotency-Key": crypto.randomUUID(),
						},
						body: JSON.stringify({ ttlSeconds: TTL_SECONDS }),
					},
					[200, 201],
				),
			),
		);
		if (
			renewed.id !== current.id ||
			(current.bootEpoch !== undefined &&
				renewed.bootEpoch !== current.bootEpoch) ||
			TERMINAL.includes(String(renewed.status))
		)
			throw new LarmError("larm_renew_invalid");
		const claimed = record(
			await readJson(await claimRequest(current.id, scoped)),
		);
		if (
			claimed.id !== current.id ||
			claimed.status !== "ready" ||
			!Array.isArray(claimed.providers)
		)
			throw new LarmError("larm_invalid_claim");
		const expiresAt = claimExpiry(claimed);
		if (
			!Number.isFinite(expiresAt) ||
			expiresAt <= Date.now() + RENEW_MARGIN_MS
		)
			throw new LarmError("larm_renew_expired");
		const info = llmOf(claimed);
		const previous = current.provider;
		if (
			!info ||
			info.model !== previous.model ||
			info.protocol !== LLM_PROTOCOL
		)
			throw new LarmError("larm_renew_claim_mismatch");
		const next = claimedProvider(info);
		if (next.baseUrl !== info.baseUrl)
			throw new LarmError("larm_renew_claim_mismatch");
		if (
			Object.entries(previous.contextWindow).some(
				([key, value]) =>
					(next.contextWindow as Record<string, unknown>)[key] !== value,
			)
		)
			throw new LarmError("larm_renew_context_changed");
		return { expiresAt, provider: next };
	}

	/** One terminal DELETE, even when recovery and close both clean up. */
	function release(current: Lease): Promise<void> {
		current.closing = true;
		if (lease === current) lease = undefined;
		current.release ??= control(
			`/v1/agent-connections/${encodeURIComponent(current.id)}`,
			{ method: "DELETE" },
			[204, 200, 404, 410],
		).then(
			() => log("released", {}),
			(error: unknown) => {
				current.release = undefined;
				throw error;
			},
		);
		return current.release;
	}

	/** Forgets a lease LARM has already ended (nothing to release). */
	function discard(current: Lease) {
		current.closing = true;
		if (lease === current) lease = undefined;
	}

	/** Checks the lease against LARM and renews its claim when it is close to expiring. */
	async function refresh(current: Lease, signal: AbortSignal) {
		const scoped: Control = (path, init, accepted) =>
			control(path, { ...init, signal }, accepted);
		const response = await scoped(
			`/v1/agent-connections/${current.id}`,
			{ method: "GET" },
			[200],
		).catch((error: unknown) => {
			// Only a GET of this connection establishes that its lease is gone.
			if (error instanceof LarmError && error.code === "larm_control_410")
				throw new LarmError("larm_connection_released");
			throw error;
		});
		const state = record(await readJson(response));
		signal.throwIfAborted();
		if (state.id !== current.id) throw new LarmError("larm_invalid_connection");
		if (current.bootEpoch && state.bootEpoch !== current.bootEpoch)
			throw new LarmError("larm_connection_expired");
		if (["failed", "expired", "released"].includes(String(state.status)))
			throw new LarmError(`larm_connection_${state.status}`);
		if (
			state.profile !== profile ||
			state.agentProfile !== current.agentProfile
		)
			throw new LarmError("larm_invalid_connection");
		if (state.status !== "ready") return false;
		const expiresAt = Date.parse(string(state.expiresAt));
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
			throw new LarmError("larm_expired");
		current.expiresAt = Math.min(current.expiresAt, expiresAt);
		if (current.expiresAt > Date.now() + RENEW_MARGIN_MS) return true;
		try {
			const next = await renew(scoped, current);
			if (current.closing) throw new LarmError("larm_connection_released");
			current.provider = next.provider;
			current.expiresAt = next.expiresAt;
			return true;
		} catch (error) {
			// The caller's cancellation says nothing about the lease.
			if (signal.aborted && (error as Error)?.name === "AbortError")
				throw error;
			await release(current).catch(() => {});
			throw error;
		}
	}

	const gone = [
		"larm_expired",
		"larm_connection_expired",
		"larm_connection_released",
		"larm_control_404",
	];

	return {
		/** A usable lease: the held one, renewed when close to expiry, else a new connection. */
		async connect(caller: AbortSignal): Promise<Lease> {
			caller.throwIfAborted();
			if (lifetime.aborted) throw new LarmError("larm_closed");
			const signal = AbortSignal.any([
				lifetime,
				AbortSignal.timeout(PREPARE_MS),
				caller,
			]);
			if (
				lease &&
				!lease.closing &&
				lease.expiresAt > Date.now() + RENEW_MARGIN_MS
			)
				return lease;
			if (lease && !lease.closing) {
				const current = lease;
				try {
					if (await refresh(current, signal)) return current;
					// Not ready (a profile switch): replace it.
					await release(current).catch(() => {});
				} catch (error) {
					if (!(error instanceof LarmError) || !gone.includes(error.code))
						throw error;
					discard(current);
				}
			}
			const created = await establish(signal);
			lease = created;
			return created;
		},
		/** True when LARM has ended this connection (the generation was refused before inference). */
		async isReleased(current: Lease, signal: AbortSignal): Promise<boolean> {
			if (current.closing) return true;
			const response = await control(
				`/v1/agent-connections/${encodeURIComponent(current.id)}`,
				{ method: "GET", signal },
				[200, 404, 410],
			);
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => {});
				return true;
			}
			const state = record(await readJson(response, signal));
			return state.id === current.id && TERMINAL.includes(String(state.status));
		},
		discard,
		/** Releases the held lease, if any. */
		async close() {
			if (lease) await release(lease);
		},
		model: () => model,
	};
}
