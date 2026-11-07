import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createBrowserSession } from "./browser-session.ts";
import {
	AdapterError,
	type AdapterCommand,
	type AdapterDispatchResult,
	type AdapterTarget,
	type CapturedImage,
	type HostCall,
	type HostOutcome,
	type InspectionResult,
	type OperationRequest,
	type ExtractedContent,
	type PlatformAdapter,
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
 * operation-settle,observe,tabs,policy}.ts`, commit 98b188d2): the destination policy, the approval gate and
 * the operation ledger. Which tab is current, and which observation is registered for it, live in
 * `browser-session.ts`.
 *
 * The order inside `operate` is the contract: refuse what is wrong before anything is sent; record the intent;
 * ask for approval; write `dispatched` in a committed transaction BEFORE awaiting the adapter; settle after.
 * After a cancel nothing is sent and a late result is recorded but never adopted. After an `indeterminate`
 * result the run is over: nothing is sent again — except for navigation, back, wait and an operation its host
 * caller marks `recoverable` (a host-checked search), which come back as an unconfirmed result.
 */

export type Executed =
	| { kind: "outcome"; outcome: HostOutcome }
	| { kind: "end"; status: RunEndStatus; code: string };

/** What only the host's own callers (the part executor) may set; a model's call never carries it. */
export type ExecuteOptions = {
	/**
	 * The typed value was already checked against the request by the caller (a search query is a few words the
	 * request supplies, not one quotation). Without it a `page.fill` needs an input provenance.
	 */
	valueChecked?: boolean;
	/**
	 * A request that an indeterminate result of this operation not end the run: the caller (a host part) believes
	 * that sending it again cannot do harm (a search). The host grants it only when its own inspection of the
	 * target shows a GET form or no form; for a POST, dialog or undescribed form the outcome stays `indeterminate`
	 * and nothing is sent again. Navigation, back and wait are always recoverable.
	 */
	recoverable?: boolean;
	/** What a granted value is for (design R19): checked against the purpose the user approved it for. */
	grantPurpose?: string;
};

/** Whether submitting from the inspected element sends a GET or nothing form-shaped: a second try cannot duplicate it. */
const readOnlySubmit = (info: InspectionResult) =>
	info.inForm === false || (info.inForm === true && info.formMethod === "get");

/** Commands whose indeterminate result leaves nothing that a second try could duplicate. */
const IDEMPOTENT = new Set(["browser.navigate", "browser.back", "page.wait"]);

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
	/**
	 * A work definition's difference from Eumenes: after one of this run's own operations on a tab is
	 * confirmed, the next look at that tab may adopt the URL the page has settled on (a redirect or a
	 * `replaceState` after the action returned), provided nothing else moved. Off for `runTrial`, which keeps
	 * Eumenes' rule that a tab is only the same tab while its index and URL both match.
	 */
	followOwnNavigation?: boolean;
	/** Keeps page text (element names) out of the ledger and the transcript: a real site without `--keep-observations`. */
	scrub?: boolean;
	/** Gets every observation the model is shown, for a run that keeps them (plan.md §14). */
	keepObservation?: (observation: {
		url?: string;
		title?: string;
		body: string;
	}) => void;
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

/** The command with its element name replaced (the name is page text). */
const named = (command: AdapterCommand, element: string): AdapterCommand =>
	"element" in command ? { ...command, element } : command;

const stableJson = (value: unknown) => JSON.stringify(value);

export type Executor = ReturnType<typeof createExecutor>;

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

	const session = createBrowserSession({
		runId,
		sessionId: deps.sessionId,
		adapter,
		policy: deps.policy,
		tabs,
		recorder,
		logger,
		control,
		now: deps.now,
		newId: deps.newId,
		followOwnNavigation: deps.followOwnNavigation,
		keepObservation: deps.keepObservation,
	});

	/**
	 * `page.extract`: the main text of the tab's page by the adapter's fixed function. Read-only, so no ledger
	 * row; the root must be a ref of the tab's latest observation, and the page it read must pass the policy.
	 */
	async function extract(
		tabRef: string,
		observationRef: string | undefined,
		targetRef: string | null,
		maxChars: number,
	): Promise<ExtractedContent> {
		if (targetRef !== null)
			tabs.assertActionable(tabRef, observationRef, targetRef);
		await session.ensureCurrent(tabRef);
		const content = await session.readAdapter(() =>
			adapter.extract(targetRef, maxChars, control.signal),
		);
		const verdict = deps.policy(content.url ?? tabs.require(tabRef).url);
		if (!verdict.ok) {
			tabs.block(tabRef);
			throw new Refusal(verdict.code, false);
		}
		return content;
	}

	/**
	 * The tab's list-ordering choices by the adapter's fixed `inspectSort` (custom dropdowns out of the
	 * accessibility tree too). Read-only, like `extract`: nothing in the page changes.
	 */
	async function choices(
		tabRef: string,
		observationRef: string,
		targetRef: string | null,
		offset: number,
		limit: number,
	): Promise<InspectionResult> {
		if (targetRef !== null)
			tabs.assertActionable(tabRef, observationRef, targetRef);
		else if (tabs.require(tabRef).observationRef !== observationRef)
			throw new Refusal("observation_stale");
		await session.ensureCurrent(tabRef);
		if (!adapter.choices) throw new Refusal("unsupported", false);
		return session.readAdapter(() =>
			adapter.choices!(targetRef, offset, limit, control.signal),
		);
	}

	async function sortOptions(tabRef: string): Promise<InspectionResult> {
		await session.ensureCurrent(tabRef);
		return session.readAdapter(() =>
			adapter.inspect("inspectSort", null, control.signal),
		);
	}

	/**
	 * `inspectTarget` for a part (an `<a>`'s `href`): read-only, and the ref must belong to the tab's latest
	 * observation, as for an operation.
	 */
	async function inspectTargetOf(
		tabRef: string,
		observationRef: string | undefined,
		targetRef: string,
	): Promise<InspectionResult> {
		tabs.assertActionable(tabRef, observationRef, targetRef);
		await session.ensureCurrent(tabRef);
		return session.readAdapter(() =>
			adapter.inspect("inspectTarget", targetRef, control.signal),
		);
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
			case "navigate":
				return "このページで読んだ文字列を含むアドレスを開きます。文字列がサイトへ送られる可能性があります";
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
					: command.action === "browser.navigate"
						? command.url
						: "element" in command
							? command.element
							: "",
			valueDigest: command.action === "page.fill" ? sha256(command.text) : null,
		};
	}

	async function operate(
		call: Extract<HostCall, { kind: "operate" }>,
		options: ExecuteOptions = {},
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
			if (!provenance && !options.valueChecked)
				throw new Refusal("value_source");
			if (!provenance) {
				// Checked by the host's own caller.
			} else if (provenance.kind === "request_quote")
				assertQuoted(command.text, provenance.quote, deps.request);
			else {
				command = {
					...command,
					text: deps.grants.use(
						provenance.inputValueRef,
						tabs.require(tabRef).url,
						options.grantPurpose,
					),
				};
				granted = true;
			}
			valueDigest = sha256(command.text);
		}
		// 2. The tab is current and the approval decision is made from what the element is.
		await session.ensureCurrent(tabRef);
		const tab = tabs.require(tabRef);
		const guard = commitGuard(command, call.declaredEffect);
		const info = guard ? await inspect(guard) : null;
		const needsApproval = guard ? approvalNeeded(guard, info) : false;
		// A part's `recoverable` is a request: it is granted only when the host's own inspection of the target
		// shows a GET form or no form. A POST (or dialog, or undescribed) form, or no inspection at all, keeps an
		// unknown outcome `indeterminate`, so nothing is ever sent again.
		const recoverable =
			options.recoverable === true && info !== null && readOnlySubmit(info);
		// 3. The intent is recorded; the transcript shows the command as the user would, not a granted value.
		const operationId = deps.newId();
		const approvalId = needsApproval ? deps.newId() : undefined;
		const request: OperationRequest = {
			operationId,
			sessionId: deps.sessionId,
			generation: tab.generation,
			...(call.observationRef ? { observationRef: call.observationRef } : {}),
			command: deps.scrub ? named(command, "(redacted)") : command,
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
			command: deps.scrub
				? named(
						granted && command.action === "page.fill"
							? { ...command, text: "" }
							: command,
						"",
					)
				: granted && command.action === "page.fill"
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
				await session.ensureCurrent(tabRef);
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
		return settle(
			call,
			operationId,
			tabRef,
			sent,
			deps.now() - began,
			recoverable,
		);
	}

	/** Records what the adapter answered, then decides what the model may see of it. */
	async function settle(
		call: Extract<HostCall, { kind: "operate" }>,
		operationId: string,
		tabRef: string,
		sent: AdapterDispatchResult,
		durationMs: number,
		recoverable = false,
	): Promise<Executed> {
		let { status, code } = sent;
		let retryable = status === "indeterminate" ? false : sent.retryable;
		// An idempotent step whose outcome is unknown is settled as failed, not left indeterminate: nothing it did
		// can be duplicated by doing it again, so the run need not end. Its page is void all the same (bumped).
		const recovered =
			status === "indeterminate" &&
			(recoverable || IDEMPOTENT.has(call.command.action));
		if (recovered) {
			status = "failed";
			code = `unconfirmed_${code ?? "indeterminate"}`;
		}
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
		try {
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
		} catch {
			// Dispatch already happened. Preserve the unsettled ledger row and never adopt or resend.
			tabs.bump(tabRef);
			halted = "operation_persistence_failed";
			throw new RunEnd("indeterminate", halted);
		}
		// A sent command may have changed the page: its observations are void.
		if (status === "confirmed" || status === "indeterminate" || recovered) {
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
		session.noteOwnNavigation(tabRef);
		const observation = await session.observeAfter(tabRef);
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
		await session.ensureCurrent(tabRef);
		const observation = await session.observeAfter(tabRef);
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
		const fresh = session
			.adopt(list, true)
			.map((ref) => tabs.get(ref)!)
			.filter((t) => t.status === "open");
		const created = fresh.find((t) => t.current) ?? fresh.at(-1);
		if (!created) throw new Refusal("tab_lost");
		const observation = await session.observeAfter(created.tabRef);
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

	/**
	 * `page.capture`: the screenshot of the tab's page by the adapter's fixed function. Read-only, so no ledger
	 * row; an element capture needs a ref of the tab's latest observation, and the page as it is after the
	 * capture must pass the policy (or the image is never handed back). Saving the image is the caller's job.
	 */
	async function capture(
		tabRef: string,
		observationRef: string | undefined,
		range: "viewport" | "full" | "item",
		targetRef: string | null,
	): Promise<CapturedImage> {
		if (range === "item") {
			if (targetRef === null) throw new Refusal("item_required", false);
			tabs.assertActionable(tabRef, observationRef, targetRef);
		}
		await session.ensureCurrent(tabRef);
		const image = await session.readAdapter(() =>
			adapter.capture(
				range,
				range === "item" ? targetRef : null,
				control.signal,
			),
		);
		// The page may have moved while the image was taken: the tab list is read again (refusing a tab whose
		// page left the policy) and the tab's URL now is what is checked, not the one before the capture.
		await session.ensureCurrent(tabRef);
		const verdict = deps.policy(tabs.require(tabRef).url);
		if (!verdict.ok) {
			tabs.block(tabRef);
			throw new Refusal(verdict.code, false);
		}
		return image;
	}

	/** Executes one call. A refusal comes back as data for the model; the end of the run comes back as `end`. */
	async function execute(
		call: HostCall,
		options: ExecuteOptions = {},
	): Promise<Executed> {
		try {
			if (control.signal.aborted) throw control.ended();
			if (halted !== null) throw new RunEnd("indeterminate", halted);
			if (adapter.state() !== "open")
				throw new RunEnd("failed", "browser_disconnected");
			switch (call.kind) {
				case "tabs.list": {
					session.adopt(
						await session.readAdapter(() =>
							adapter.listTargets(control.signal),
						),
					);
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
							observation: await session.observeTab(call.tabRef),
						},
					};
				}
				case "operate":
					return await operate(call, options);
				case "part":
					// A part is run by the part executor, which calls this one for each inner operation.
					throw new Refusal("not_a_host_call", false);
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

	return {
		execute,
		start: session.start,
		attach: session.attach,
		extract,
		capture,
		sortOptions,
		choices,
		inspectTarget: inspectTargetOf,
	};
}
