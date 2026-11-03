import type { AdapterTarget, TabView } from "eumenes-interact";
import { Refusal } from "./types.ts";

/**
 * What the host knows of the tabs: stable refs over the adapter's unstable tab indexes, the latest
 * observation of each tab and its generation. Ported from Eumenes' `browser/service/tabs.ts` (commit 98b188d2:
 * `matchTabs`, `reconcileTabs`, `assertActionable`, `dropTab`), without the DB and the leases (one run owns
 * the session here). In memory: a restart never resumes a session.
 */

export type TabEntry = {
	tabRef: string;
	/** The adapter's own ref (Playwright MCP: the index). */
	index: string;
	url: string;
	title: string;
	current: boolean;
	status: "open" | "lost" | "blocked";
	/** Increases whenever the page may have changed; an observation of an older one is void. */
	generation: number;
	observationRef: string | null;
};

type Observed = { tabRef: string; generation: number; refs: readonly string[] };

const numeric = (index: string) => Number.parseInt(index, 10);

/**
 * Which listed tab is which tracked tab. A tab is the same tab only when index and URL both match, and only
 * when that pair is unambiguous: if several tabs share a URL, the tracked ones and the listed ones must sit at
 * exactly the same indices, otherwise an index shift could hand a tabRef to another tab, so none of them match.
 * `appended` is for the list that answers the host's own "new tab": that tab is added after every tracked one,
 * so extra listed entries beyond the last tracked index are not a shift.
 */
export function matchTabs(
	tracked: readonly TabEntry[],
	list: readonly AdapterTarget[],
	appended = false,
): Map<string, AdapterTarget> {
	const matched = new Map<string, AdapterTarget>();
	const urlOf = (t: AdapterTarget) => t.url ?? "";
	const urls = new Set([...tracked.map((t) => t.url), ...list.map(urlOf)]);
	const last = Math.max(-1, ...tracked.map((t) => numeric(t.index)));
	for (const url of urls) {
		const mine = tracked.filter((t) => t.url === url);
		const listed = list.filter((t) => urlOf(t) === url);
		const same =
			mine.every((t) => listed.some((e) => e.targetRef === t.index)) &&
			(mine.length === listed.length ||
				(appended &&
					listed.every(
						(e) =>
							numeric(e.targetRef) > last ||
							mine.some((t) => t.index === e.targetRef),
					)));
		if (!same) continue;
		for (const t of mine)
			matched.set(
				t.tabRef,
				listed.find((e) => e.targetRef === t.index)!,
			);
	}
	return matched;
}

export class TabRegistry {
	private readonly tabs = new Map<string, TabEntry>();
	private readonly observations = new Map<string, Observed>();

	/** Open tabs in the order they were first seen. */
	open(): TabEntry[] {
		return [...this.tabs.values()].filter((t) => t.status === "open");
	}

	get(tabRef: string): TabEntry | undefined {
		return this.tabs.get(tabRef);
	}

	/** A tab the host can act on: a blocked one says why it is not usable, anything else is lost. */
	require(tabRef: string): TabEntry {
		const tab = this.tabs.get(tabRef);
		if (tab?.status === "blocked") throw new Refusal("tab_blocked", false);
		if (!tab || tab.status !== "open") throw new Refusal("tab_lost");
		return tab;
	}

	/** The adapter entry a tracked tab matches in `list`, after `reconcile` updated the inventory. */
	targetOf(tab: TabEntry, list: readonly AdapterTarget[]) {
		return matchTabs(this.open(), list).get(tab.tabRef);
	}

	/**
	 * Matches the adapter's list against the tabs the host issued refs for. Anything unmatched is lost, and an
	 * entry nobody holds a ref for gets a new one, never a similar tab in place of a missing one. An entry whose
	 * page the host must not adopt (`blocked`, by adapter ref) blocks the tab it matches and never gets a ref.
	 * Returns the refs issued by this call.
	 */
	reconcile(
		list: readonly AdapterTarget[],
		blocked: ReadonlyMap<string, string>,
		newRef: () => string,
		appended = false,
	): string[] {
		const tracked = this.open();
		const matched = matchTabs(tracked, list, appended);
		const claimed = new Set<string>();
		const issued: string[] = [];
		for (const entry of list) {
			const hit = tracked.find((t) => matched.get(t.tabRef) === entry);
			if (hit) claimed.add(hit.tabRef);
			if (blocked.has(entry.targetRef)) {
				if (hit) this.drop(hit.tabRef, "blocked");
			} else if (hit) {
				hit.title = entry.title ?? hit.title;
				hit.current = entry.current;
			} else {
				const tabRef = newRef();
				this.tabs.set(tabRef, {
					tabRef,
					index: entry.targetRef,
					url: entry.url ?? "",
					title: entry.title ?? "",
					current: entry.current,
					status: "open",
					generation: 0,
					observationRef: null,
				});
				issued.push(tabRef);
			}
		}
		for (const t of tracked)
			if (!claimed.has(t.tabRef)) this.drop(t.tabRef, "lost");
		return issued;
	}

	/** The page changed or may have: observations of the tab are void. */
	bump(tabRef: string) {
		const tab = this.tabs.get(tabRef);
		if (!tab) return;
		tab.generation += 1;
		tab.observationRef = null;
	}

	/** Cancel and expiry void everything (plan.md §9). */
	invalidateAll() {
		for (const tab of this.tabs.values()) this.bump(tab.tabRef);
	}

	patch(tabRef: string, page: { url?: string; title?: string }) {
		const tab = this.tabs.get(tabRef);
		if (!tab) return;
		if (page.url !== undefined) tab.url = page.url;
		if (page.title) tab.title = page.title;
	}

	block(tabRef: string) {
		this.drop(tabRef, "blocked");
	}

	private drop(tabRef: string, status: "lost" | "blocked") {
		const tab = this.tabs.get(tabRef);
		if (!tab || tab.status !== "open") return;
		tab.status = status;
		tab.current = false;
		tab.generation += 1;
		tab.observationRef = null;
	}

	record(tabRef: string, observationRef: string, refs: readonly string[]) {
		const tab = this.require(tabRef);
		tab.observationRef = observationRef;
		this.observations.set(observationRef, {
			tabRef,
			generation: tab.generation,
			refs,
		});
	}

	/** An element ref is actionable only for the tab's latest observation of its current generation. */
	assertActionable(
		tabRef: string,
		observationRef: string | undefined,
		ref: string,
	) {
		const tab = this.require(tabRef);
		const seen = observationRef
			? this.observations.get(observationRef)
			: undefined;
		if (
			!seen ||
			seen.tabRef !== tabRef ||
			seen.generation !== tab.generation ||
			tab.observationRef !== observationRef
		)
			throw new Refusal("observation_stale");
		if (!seen.refs.includes(ref)) throw new Refusal("ref_not_actionable");
	}

	views(): TabView[] {
		return this.open().map((t) => ({
			tabRef: t.tabRef,
			url: t.url,
			title: t.title,
			current: t.current,
		}));
	}
}
