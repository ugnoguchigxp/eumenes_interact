import {
	AdapterError,
	shapeObservation,
	type AdapterTarget,
	type ObservationEnvelope,
	type PlatformAdapter,
	type RawObservation,
	type ShapedObservation,
	type TabView,
} from "eumenes-interact";
import type { RunControl } from "./control.ts";
import type { LabLogger } from "./log.ts";
import type { UrlPolicy } from "./policy.ts";
import { matchTabs, type TabEntry, type TabRegistry } from "./tabs.ts";
import type { TrialRecorder } from "./trial.ts";
import { Refusal, RunEnd } from "./types.ts";

/**
 * The browser session around one run: which tabs exist, which page a tab has settled on, and the observation
 * registered for that page. The operation ledger (intent, approval, `dispatched`, settle) stays in `executor.ts`
 * and calls this module when it needs the current tab or a fresh observation. An Arm 1 observation is shaped
 * by the package core, so the actionable refs are the ones the parts read from the same snapshot.
 */

export type BrowserSessionDeps = {
	runId: string;
	sessionId: string;
	adapter: PlatformAdapter;
	policy: UrlPolicy;
	tabs: TabRegistry;
	recorder: TrialRecorder;
	logger: LabLogger;
	control: RunControl;
	now: () => number;
	newId: () => string;
	/** After a confirmed operation, the next look at that tab may adopt the URL the page settled on. */
	followOwnNavigation?: boolean;
	keepObservation?: (observation: {
		url?: string;
		title?: string;
		body: string;
	}) => void;
};

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

function wholeObservation(raw: RawObservation): ShapedObservation {
	return shapeObservation("arm1", raw);
}

export function createBrowserSession(deps: BrowserSessionDeps) {
	const { adapter, tabs, recorder, control } = deps;
	/** The number of tabs the last look listed, and the tab whose next look may follow its own navigation. */
	let lastCount = 0;
	let followPending: { tabRef: string; count: number } | null = null;
	const log = (
		name: Parameters<LabLogger["lab"]>[0],
		fields: { code?: string; durationMs?: number } = {},
	) => deps.logger.lab(name, { correlationId: deps.runId, ...fields });

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
	 * The tab's page settled on another URL after its own operation (definition runs only). Adopted when the
	 * tab count is as before, exactly one listed tab sits at the tab's index, every other tracked tab still
	 * matches by index and URL, and the new URL passes the policy; a refused URL blocks the tab. Anything else
	 * leaves the tab lost, as in Eumenes.
	 */
	function followNavigation(
		tab: TabEntry,
		list: readonly AdapterTarget[],
		countBefore: number,
	): boolean {
		if (list.length !== countBefore) return false;
		const atIndex = list.filter((target) => target.targetRef === tab.index);
		if (atIndex.length !== 1) return false;
		const others = tabs.open().filter((entry) => entry.tabRef !== tab.tabRef);
		const rest = list.filter((target) => target.targetRef !== tab.index);
		if (matchTabs(others, rest).size !== others.length) return false;
		const moved = atIndex[0]!;
		const verdict = deps.policy(moved.url ?? "");
		if (!verdict.ok) {
			tabs.block(tab.tabRef);
			throw new Refusal(verdict.code, false);
		}
		tabs.patch(tab.tabRef, {
			url: moved.url ?? "",
			...(moved.title === undefined ? {} : { title: moved.title }),
		});
		// The page is not the one observed: its observations are void.
		tabs.bump(tab.tabRef);
		log("tab.navigation_followed", { code: "tab_url_settled" });
		return true;
	}

	/**
	 * Which listed tab is the tracked one, then makes it the current one (Eumenes `selectMatched`): the
	 * (index, URL) pair must be present and unambiguous, and its page must be one the host may adopt.
	 */
	async function ensureCurrent(tabRef: string): Promise<AdapterTarget> {
		const tab = tabs.require(tabRef);
		// Taken once: only the first look after the operation may follow the page's own navigation.
		const follow = followPending?.tabRef === tabRef ? followPending : null;
		if (follow) followPending = null;
		const find = (list: readonly AdapterTarget[]) => {
			lastCount = list.length;
			let hit = tabs.targetOf(tab, list);
			if (!hit && follow && followNavigation(tab, list, follow.count))
				hit = tabs.targetOf(tab, list);
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
		const shaped = wholeObservation(raw);
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
			capturedAt: new Date(deps.now()).toISOString(),
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
		deps.keepObservation?.({
			...(raw.url === undefined ? {} : { url: raw.url }),
			...(raw.title === undefined ? {} : { title: raw.title }),
			body: shaped.body,
		});
		recorder.observation({
			observationRef,
			...(raw.url === undefined ? {} : { url: raw.url }),
			...(raw.title === undefined ? {} : { title: raw.title }),
			refCount: shaped.refCount,
			bodyBytes: utf8Bytes(raw.body),
			shapedBytes: utf8Bytes(shaped.body),
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
		const tab = tabs.open().find((entry) => entry.current) ?? tabs.open()[0];
		if (!tab) throw new RunEnd("failed", "start_page_failed");
		return { observation: await observeTab(tab.tabRef), tabs: tabs.views() };
	}

	/** The tab the session starts on (the browser's current one), for a run that does not open a start page. */
	async function attach(): Promise<string> {
		adopt(await readAdapter(() => adapter.listTargets(control.signal)));
		const tab = tabs.open().find((entry) => entry.current) ?? tabs.open()[0];
		if (!tab) throw new RunEnd("failed", "no_tab");
		return tab.tabRef;
	}

	/** Records that the next look at this tab may follow the URL its own confirmed operation settled on. */
	function noteOwnNavigation(tabRef: string) {
		if (deps.followOwnNavigation) followPending = { tabRef, count: lastCount };
	}

	return {
		readAdapter,
		adopt,
		ensureCurrent,
		observeTab,
		observeAfter,
		start,
		attach,
		noteOwnNavigation,
	};
}
