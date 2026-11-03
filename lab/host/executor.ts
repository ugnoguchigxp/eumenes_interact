import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	AdapterError,
	shapeObservation,
	type AdapterCommand,
	type AdapterDispatchResult,
	type AdapterTarget,
	type HostCall,
	type HostOutcome,
	type InspectionResult,
	type ObservationEnvelope,
	type OperationRequest,
	type PlatformAdapter,
	type TabView,
} from "eumenes-interact";
import {
	isInteractStoreError,
	markOperationDispatched,
	recordOperationIntent,
	settleOperation,
} from "eumenes-interact/sqlite";
import {
	ApprovalLedger,
	type ApprovalBinding,
	type Approver,
} from "./approval.ts";
import type { RunControl } from "./control.ts";
import { write } from "./db.ts";
import {
	approvalNeeded,
	commitGuard,
	type ApprovalAction,
	type CommitGuard,
} from "./gate.ts";
import { assertQuoted, type InputGrants } from "./grants.ts";
import type { LabLogger } from "./log.ts";
import type { UrlPolicy } from "./policy.ts";
import type { TabRegistry } from "./tabs.ts";
import type { TrialRecorder } from "./trial.ts";
import { Refusal, RunEnd, type RunEndStatus } from "./types.ts";

/**
 * Executes the core's validated `HostCall`s with the checks Eumenes' browser domain makes around them
 * (plan.md §5.5, §9; ported from `browser/service/{operations,operation-plan,operation-checks,
 * operation-settle,observe,tabs,policy}.ts`, commit 98b188d2): stable tab refs, the observation registry,
 * the destination policy, the approval gate and the operation ledger.
 *
 * The order inside `operate` is the contract: refuse what is wrong before anything is sent; record the intent;
 * ask for approval; write `dispatched` in a committed transaction BEFORE awaiting the adapter; settle after.
 * After a cancel nothing is sent and a late result is recorded but never adopted. After an `indeterminate`
 * result the run is over: nothing is sent again.
 */

export type Executed =
	| { kind: "outcome"; outcome: HostOutcome }
	| { kind: "end"; status: RunEndStatus; code: string };

export type ExecutorDeps = {
	db: Database;
	owner: string;
	runId: string;
	sessionId: string;
	adapter: PlatformAdapter;
	policy: UrlPolicy;
	tabs: TabRegistry;
	grants: InputGrants;
	approver: Approver;
	recorder: TrialRecorder;
	logger: LabLogger;
	control: RunControl;
	now: () => number;
	newId: () => string;
	/** The user's request: what a typed quotation is checked against. */
	request: string;
};

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

/** Origin and path of a page; query and fragment can carry tokens, search terms and ids. */
const pagePath = (raw: string) => {
	try {
		const url = new URL(raw);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return "";
	}
};

const SUMMARY_CHARS = 160;
const clip = (text: string) => text.slice(0, SUMMARY_CHARS);

/** An adapter code that is also a valid stored classification; anything else is stored as a generic one. */
const storable = (code: string | undefined, fallback: string) =>
	code !== undefined && /^[a-z][a-z0-9_.]{0,63}$/.test(code) ? code : fallback;

const stableJson = (value: unknown) => JSON.stringify(value);

export function createExecutor(deps: ExecutorDeps) {
	const { db, owner, runId, adapter, tabs, recorder, control, logger } = deps;
	const approvals = new ApprovalLedger(deps.now);
	const nowIso = () => new Date(deps.now()).toISOString();
	/** Commands already requested, for `retryOf`. */
	const requested = new Map<string, string>();
	let halted: string | null = null;

	const log = (
		name: Parameters<LabLogger["lab"]>[0],
		fields: { code?: string; durationMs?: number } = {},
	) => logger.lab(name, { correlationId: runId, ...fields });

	/** Read-only adapter calls never reached the page: a failure is a refusal the model may answer. */
	async function readAdapter<T>(run: () => Promise<T>): Promise<T> {
		if (control.signal.aborted) throw control.ended();
		try {
			return await run();
		} catch (error) {
			if (control.signal.aborted) throw control.ended();
			if (error instanceof AdapterError) throw new Refusal(error.code);
			throw error;
		}
	}

	/** Destination verdicts of every listed page, by adapter ref. */
	function verdicts(list: readonly AdapterTarget[]) {
		const blocked = new Map<string, string>();
		for (const target of list) {
			const verdict = deps.policy(target.url ?? "");
			if (!verdict.ok) blocked.set(target.targetRef, verdict.code);
		}
		return blocked;
	}

	/** Adopts the adapter's list into the registry; returns the refs issued for tabs not seen before. */
	function adopt(list: readonly AdapterTarget[], appended = false) {
		return tabs.reconcile(list, verdicts(list), deps.newId, appended);
	}

	/**
	 * Which listed tab is the tracked one, then makes it the current one (Eumenes `selectMatched`): the
	 * (index, URL) pair must be present and unambiguous, and its page must be one the host may adopt.
	 */
	async function ensureCurrent(tabRef: string): Promise<AdapterTarget> {
		const tab = tabs.require(tabRef);
		const find = (list: readonly AdapterTarget[]) => {
			const hit = tabs.targetOf(tab, list);
			const blocked = verdicts(list);
			adopt(list);
			if (hit && !blocked.has(hit.targetRef)) return hit;
			throw new Refusal(hit ? blocked.get(hit.targetRef)! : "tab_lost", !hit);
		};
		const hit = find(
			await readAdapter(() => adapter.listTargets(control.signal)),
		);
		if (hit.current) return hit;
		const after = await readAdapter(() =>
			adapter.selectTarget(hit.targetRef, control.signal),
		);
		const now = find(after);
		if (!now.current) throw new Refusal("tab_lost");
		return now;
	}

	/** A fresh observation of the tab, registered so its refs are actionable until the page may change. */
	async function observeTab(tabRef: string): Promise<ObservationEnvelope> {
		await ensureCurrent(tabRef);
		const raw = await readAdapter(() => adapter.observe(control.signal));
		const verdict = deps.policy(raw.url ?? "");
		if (!verdict.ok) {
			tabs.block(tabRef);
			throw new Refusal(verdict.code, false);
		}
		const shaped = shapeObservation("arm0", raw);
		tabs.patch(tabRef, {
			...(raw.url === undefined ? {} : { url: raw.url }),
			...(raw.title === undefined ? {} : { title: raw.title }),
		});
		const observationRef = deps.newId();
		tabs.record(tabRef, observationRef, shaped.refs);
		const envelope: ObservationEnvelope = {
			observationRef,
			platform: adapter.platform,
			sessionId: deps.sessionId,
			target: { kind: "tab", tabRef },
			generation: tabs.require(tabRef).generation,
			capturedAt: nowIso(),
			...(raw.url === undefined ? {} : { url: raw.url }),
			...(raw.title === undefined ? {} : { title: raw.title }),
			body: shaped.body,
			// The core reports its own cut; the adapter's is merged here.
			truncated: shaped.truncated || raw.truncated,
			truncationReasons: raw.truncated
				? [...shaped.truncationReasons, "adapter"]
				: shaped.truncationReasons,
			refCount: shaped.refCount,
			missing: raw.missing,
		};
		recorder.observation({
			observationRef,
			...(raw.url === undefined ? {} : { url: raw.url }),
			...(raw.title === undefined ? {} : { title: raw.title }),
			refCount: shaped.refCount,
		});
		return envelope;
	}

	/** The page after a call that may have changed it; a page that cannot be observed leaves it out. */
	async function observeAfter(tabRef: string) {
		try {
			return await observeTab(tabRef);
		} catch (error) {
			if (error instanceof Refusal) return undefined;
			throw error;
		}
	}

	/**
	 * Opens the start page the way a user has it open: the session's first tab navigates there. Returns the
	 * tabs and the first observation for the core's REFERENCE. Not a model operation: no ledger row.
	 */
	async function start(
		url: string,
	): Promise<{ tabs: TabView[]; observation: ObservationEnvelope }> {
		const verdict = deps.policy(url);
		if (!verdict.ok) throw new RunEnd("failed", verdict.code);
		const result = await adapter.dispatch(
			{ action: "browser.navigate", url: verdict.url },
			control.signal,
		);
		if (control.signal.aborted) throw control.ended();
		if (result.status !== "confirmed")
			throw new RunEnd("failed", "start_page_failed");
		adopt(await readAdapter(() => adapter.listTargets(control.signal)));
		const tab = tabs.open().find((t) => t.current) ?? tabs.open()[0];
		if (!tab) throw new RunEnd("failed", "start_page_failed");
		return { observation: await observeTab(tab.tabRef), tabs: tabs.views() };
	}

	/** The element facts for the approval decision; reading never reaches the page's state. */
	async function inspect(guard: CommitGuard): Promise<InspectionResult | null> {
		if (guard.declared) return null;
		try {
			return guard.probe === "focused"
				? await adapter.inspect("inspectFocused", null, control.signal)
				: await adapter.inspect(
						"inspectTarget",
						guard.probe.ref,
						control.signal,
					);
		} catch (error) {
			if (control.signal.aborted) throw control.ended();
			if (error instanceof AdapterError) throw new Refusal(error.code);
			throw error;
		}
	}

	const summaryOf = (action: ApprovalAction, command: AdapterCommand) => {
		switch (action) {
			case "click":
				return `「${"element" in command ? command.element : ""}」をクリックします（送信・確定の操作）`;
			case "press":
				return `キー ${command.action === "page.press" ? command.key : ""} を押します（送信・確定の操作）`;
			case "type":
				return `「${"element" in command ? command.element : ""}」へ入力して送信します（送信・確定の操作）`;
		}
	};

	/** Settles an operation that never left the host. */
	function settleUnsent(operationId: string, code: string) {
		write(db, () =>
			settleOperation(db, owner, operationId, {
				status: "failed",
				code,
				retryable: false,
				nowIso: nowIso(),
			}),
		);
	}

	/** What an approval is bound to, from the registry's current state and the command about to be sent. */
	function bindingOf(
		tabRef: string,
		guard: CommitGuard,
		command: AdapterCommand,
	): ApprovalBinding {
		return {
			tabRef,
			page: pagePath(tabs.require(tabRef).url),
			action: guard.action,
			element:
				command.action === "page.press"
					? command.key
					: "element" in command
						? command.element
						: "",
			valueDigest: command.action === "page.fill" ? sha256(command.text) : null,
		};
	}

	async function operate(
		call: Extract<HostCall, { kind: "operate" }>,
	): Promise<Executed> {
		const { tabRef } = call;
		if (!tabRef) throw new Refusal("no_target_tab");
		let command = call.command;
		// 1. Destination, element refs and the typed value, all before anything is recorded.
		if (command.action === "browser.navigate") {
			const verdict = deps.policy(command.url);
			if (!verdict.ok) throw new Refusal(verdict.code, false);
			command = { ...command, url: verdict.url };
		}
		const targeted = "targetRef" in command ? command.targetRef : undefined;
		if (targeted !== undefined)
			tabs.assertActionable(tabRef, call.observationRef, targeted);
		let valueDigest: string | null = null;
		let granted = false;
		if (command.action === "page.fill") {
			const provenance = call.inputProvenance;
			if (!provenance) throw new Refusal("value_source");
			if (provenance.kind === "request_quote")
				assertQuoted(command.text, provenance.quote, deps.request);
			else {
				command = {
					...command,
					text: deps.grants.use(
						provenance.inputValueRef,
						tabs.require(tabRef).url,
					),
				};
				granted = true;
			}
			valueDigest = sha256(command.text);
		}
		// 2. The tab is current and the approval decision is made from what the element is.
		await ensureCurrent(tabRef);
		const tab = tabs.require(tabRef);
		const guard = commitGuard(command, call.declaredEffect);
		const needsApproval = guard
			? approvalNeeded(guard, await inspect(guard))
			: false;
		// 3. The intent is recorded; the transcript shows the command as the user would, not a granted value.
		const operationId = deps.newId();
		const approvalId = needsApproval ? deps.newId() : undefined;
		const request: OperationRequest = {
			operationId,
			sessionId: deps.sessionId,
			generation: tab.generation,
			...(call.observationRef ? { observationRef: call.observationRef } : {}),
			command,
			declaredEffect: call.declaredEffect,
			...(approvalId ? { approvalRef: approvalId } : {}),
		};
		try {
			write(db, () =>
				recordOperationIntent(db, owner, runId, {
					request,
					...(valueDigest ? { inputDigest: `sha256:${valueDigest}` } : {}),
					nowIso: nowIso(),
				}),
			);
		} catch (error) {
			if (isInteractStoreError(error) && error.code === "run_not_running")
				throw control.ended();
			throw error;
		}
		const key = stableJson(command);
		const retryOf = requested.get(key);
		requested.set(key, operationId);
		recorder.requested({
			operationId,
			command:
				granted && command.action === "page.fill"
					? { ...command, text: "" }
					: command,
			declaredEffect: call.declaredEffect,
			requiresApproval: needsApproval,
			...(retryOf ? { retryOf } : {}),
		});
		try {
			// 4. Approval: asked here, answered by the approver port, valid for this operation once.
			if (guard && approvalId) {
				const binding = bindingOf(tabRef, guard, command);
				recorder.approvalRequested(approvalId, operationId);
				log("approval.requested");
				const decision = await deps.approver
					.decide(
						{
							approvalId,
							operationId,
							tabRef,
							page: binding.page,
							action: guard.action,
							element: binding.element,
							summary: clip(summaryOf(guard.action, command)),
							...(command.action === "page.fill"
								? { content: command.text }
								: {}),
						},
						control.signal,
					)
					.catch(() => "deny" as const);
				if (control.signal.aborted) throw control.ended();
				recorder.approvalAnswered(approvalId, decision);
				log("approval.answered", { code: decision });
				if (decision === "deny") {
					settleUnsent(operationId, "approval_denied");
					return {
						kind: "outcome",
						outcome: {
							kind: "stop",
							code: "approval_denied",
							text: `${pagePath(tab.url)}で${clip(summaryOf(guard.action, command))}。承認されなかったため実行していません。`,
						},
					};
				}
				approvals.grant(approvalId, binding);
				// The user may have taken long: the tab and its observation must still be the ones asked about.
				await ensureCurrent(tabRef);
				if (targeted !== undefined)
					tabs.assertActionable(tabRef, call.observationRef, targeted);
				// What the approval is matched against is read again from the state at dispatch, not reused.
				if (!approvals.consume(approvalId, bindingOf(tabRef, guard, command)))
					throw new Refusal("approval_required");
			}
			// 5. `dispatched` is committed before the adapter is awaited.
			try {
				write(db, () =>
					markOperationDispatched(db, owner, operationId, nowIso()),
				);
			} catch (error) {
				if (isInteractStoreError(error) && error.code === "run_not_running")
					throw control.ended();
				throw error;
			}
		} catch (error) {
			settleUnsent(
				operationId,
				error instanceof Refusal
					? storable(error.code, "operation_refused")
					: "operation_aborted",
			);
			throw error;
		}
		recorder.dispatched(operationId);
		log("operation.dispatched");
		const began = deps.now();
		let sent: AdapterDispatchResult;
		try {
			sent = await adapter.dispatch(command, control.signal);
		} catch {
			// The adapter promises not to throw; if it does, the command may have reached the page.
			sent = {
				status: "indeterminate",
				code: "adapter_failed",
				retryable: false,
			};
		}
		return settle(call, operationId, tabRef, sent, deps.now() - began);
	}

	/** Records what the adapter answered, then decides what the model may see of it. */
	async function settle(
		call: Extract<HostCall, { kind: "operate" }>,
		operationId: string,
		tabRef: string,
		sent: AdapterDispatchResult,
		durationMs: number,
	): Promise<Executed> {
		let { status, code } = sent;
		let retryable = status === "indeterminate" ? false : sent.retryable;
		// The page the action ended on is checked like any destination: one the host must not adopt is dropped.
		if (status === "confirmed" && sent.url !== undefined) {
			const verdict = deps.policy(sent.url);
			if (!verdict.ok) {
				status = "failed";
				code = verdict.code;
				retryable = false;
				tabs.block(tabRef);
			}
		}
		write(db, () =>
			settleOperation(db, owner, operationId, {
				status: status === "not_dispatched" ? "failed" : status,
				...(code === undefined
					? {}
					: { code: storable(code, "operation_failed") }),
				retryable,
				nowIso: nowIso(),
			}),
		);
		// A sent command may have changed the page: its observations are void.
		if (status === "confirmed" || status === "indeterminate") {
			tabs.bump(tabRef);
			if (status === "confirmed")
				tabs.patch(tabRef, {
					...(sent.url === undefined ? {} : { url: sent.url }),
					...(sent.title === undefined ? {} : { title: sent.title }),
				});
		}
		log("operation.settled", {
			code: code ?? status,
			durationMs,
		});
		const cancelled = control.signal.aborted;
		const result = {
			operationId,
			status,
			retryable,
			...(code === undefined ? {} : { code }),
			...(sent.url === undefined ? {} : { url: sent.url }),
			...(sent.title === undefined ? {} : { title: sent.title }),
		};
		// A late result is recorded as a fact, never adopted (plan.md §9).
		recorder.result(
			operationId,
			result,
			!cancelled && status !== "indeterminate",
		);
		if (cancelled) throw control.ended();
		if (status === "indeterminate") {
			halted = code ?? "operation_indeterminate";
			return { kind: "end", status: "indeterminate", code: halted };
		}
		if (status !== "confirmed")
			return { kind: "outcome", outcome: { kind: "operation", result } };
		const observation = await observeAfter(tabRef);
		if (control.signal.aborted) throw control.ended();
		return {
			kind: "outcome",
			outcome: {
				kind: "operation",
				result,
				...(observation ? { observation } : {}),
			},
		};
	}

	/** Selecting a tab does not touch the page, so it needs no ledger row (the command union has no such action). */
	async function selectTab(tabRef: string): Promise<Executed> {
		await ensureCurrent(tabRef);
		const observation = await observeAfter(tabRef);
		const tab = tabs.require(tabRef);
		if (control.signal.aborted) throw control.ended();
		return {
			kind: "outcome",
			outcome: {
				kind: "operation",
				result: {
					operationId: deps.newId(),
					status: "confirmed",
					retryable: false,
					url: tab.url,
					title: tab.title,
				},
				...(observation ? { observation } : {}),
			},
		};
	}

	async function newTab(url: string): Promise<Executed> {
		const verdict = deps.policy(url);
		if (!verdict.ok) throw new Refusal(verdict.code, false);
		if (control.signal.aborted) throw control.ended();
		let list: AdapterTarget[];
		try {
			list = await adapter.newTarget(verdict.url, control.signal);
		} catch (error) {
			if (error instanceof AdapterError && !error.dispatched)
				throw new Refusal(error.code);
			if (control.signal.aborted) throw control.ended();
			halted = "tab_new_failed";
			return { kind: "end", status: "indeterminate", code: halted };
		}
		if (control.signal.aborted) throw control.ended();
		const shown = list.find((t) => t.current);
		const landed = shown ? deps.policy(shown.url ?? "") : null;
		if (landed && !landed.ok) throw new Refusal(landed.code, false);
		const fresh = adopt(list, true)
			.map((ref) => tabs.get(ref)!)
			.filter((t) => t.status === "open");
		const created = fresh.find((t) => t.current) ?? fresh.at(-1);
		if (!created) throw new Refusal("tab_lost");
		const observation = await observeAfter(created.tabRef);
		if (control.signal.aborted) throw control.ended();
		return {
			kind: "outcome",
			outcome: {
				kind: "operation",
				result: {
					operationId: deps.newId(),
					status: "confirmed",
					retryable: false,
					url: created.url,
					title: created.title,
				},
				...(observation ? { observation } : {}),
			},
		};
	}

	/** Executes one call. A refusal comes back as data for the model; the end of the run comes back as `end`. */
	async function execute(call: HostCall): Promise<Executed> {
		try {
			if (control.signal.aborted) throw control.ended();
			if (halted !== null) throw new RunEnd("indeterminate", halted);
			if (adapter.state() !== "open")
				throw new RunEnd("failed", "browser_disconnected");
			switch (call.kind) {
				case "tabs.list": {
					adopt(await readAdapter(() => adapter.listTargets(control.signal)));
					return {
						kind: "outcome",
						outcome: { kind: "tabs", tabs: tabs.views() },
					};
				}
				case "tabs.select":
					return await selectTab(call.tabRef);
				case "tabs.new":
					return await newTab(call.url);
				case "observe": {
					if (!call.tabRef) throw new Refusal("no_target_tab");
					return {
						kind: "outcome",
						outcome: {
							kind: "observation",
							observation: await observeTab(call.tabRef),
						},
					};
				}
				case "operate":
					return await operate(call);
			}
		} catch (error) {
			if (error instanceof Refusal)
				return {
					kind: "outcome",
					outcome: {
						kind: "refused",
						code: error.code,
						retryable: error.retryable,
					},
				};
			if (error instanceof RunEnd)
				return { kind: "end", status: error.status, code: error.code };
			throw error;
		}
	}

	return { execute, start };
}
