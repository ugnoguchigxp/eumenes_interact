import type { ItemRecord } from "eumenes-interact";

/**
 * The host's item registry for one run (plan.md §6.4): page id -> the records of the items issued under it,
 * with the tab and the URL of the page they were made from. Item ids are opaque to the model; a record
 * carries what the host needs to find the element again in a fresh observation. Nothing here is a ref the
 * model could use, and nothing is persisted.
 */

export type IssuedPage = {
	tabRef: string;
	/** The page as it was when the ids were issued; an id is valid only while the tab is still on it. */
	url: string;
	records: Map<string, ItemRecord>;
};

/** The registry keeps this many pages; older ones are forgotten (their ids then name nothing). */
const MAX_PAGES = 64;

const ITEM_ID = /^(p\d{1,6})\.i\d{1,5}$/;

/** A page without its fragment: the same page for the purpose of an item id. */
export function pageKey(raw: string | undefined): string {
	if (raw === undefined) return "";
	try {
		const url = new URL(raw);
		url.hash = "";
		return url.href;
	} catch {
		return raw;
	}
}

/** The same element as far as an item id is concerned: what re-resolution keys on. */
const sameElement = (a: ItemRecord, b: ItemRecord) =>
	a.role === b.role &&
	a.name === b.name &&
	a.region === b.region &&
	a.url === b.url &&
	a.nth === b.nth &&
	a.count === b.count;

export class ItemRegistry {
	private readonly pages = new Map<string, IssuedPage>();
	private counter = 0;
	private current: { id: string; tabRef: string; key: string } | null = null;
	private changed = false;

	/**
	 * An operation that may have changed the page ran (a click, a navigation, a wait): ids issued before it
	 * name elements of a page that may be gone, so the next batch gets a new page id.
	 */
	markChanged() {
		this.changed = true;
	}

	/**
	 * The page id for items of this tab's page now. The helpers number items by document order, so the summary,
	 * a list and a form of the same page agree on their ids under one page id; a page change issues a new one.
	 */
	pageIdFor(tabRef: string, url: string | undefined): string {
		const key = pageKey(url);
		if (
			this.current &&
			!this.changed &&
			this.current.tabRef === tabRef &&
			this.current.key === key
		)
			return this.current.id;
		this.current = { id: `p${++this.counter}`, tabRef, key };
		this.changed = false;
		return this.current.id;
	}

	/**
	 * Whether this batch would give an id already issued under `pageId` to a different element. The helpers
	 * number items by document order, so after the page's content moved (a field revealed, a banner gone) the
	 * same number can name another element; such a batch must get a new page id instead, so that an id the model
	 * already holds keeps naming what it named.
	 */
	conflicts(
		pageId: string,
		tabRef: string,
		records: readonly ItemRecord[],
	): boolean {
		const known = this.pages.get(pageId);
		if (!known || known.tabRef !== tabRef) return false;
		return records.some((record) => {
			const had = known.records.get(record.item);
			return had !== undefined && !sameElement(had, record);
		});
	}

	/** Remembers the records under `pageId` (as the pure helpers made them); the same page adds to what it had. */
	add(
		pageId: string,
		tabRef: string,
		url: string,
		records: readonly ItemRecord[],
	) {
		const known = this.pages.get(pageId);
		const merged = known?.tabRef === tabRef ? known.records : new Map();
		for (const record of records) merged.set(record.item, record);
		this.pages.delete(pageId);
		this.pages.set(pageId, { tabRef, url, records: merged });
		while (this.pages.size > MAX_PAGES) {
			const oldest = this.pages.keys().next().value;
			if (oldest === undefined) break;
			this.pages.delete(oldest);
		}
	}

	/** The record an id names, with the page it was issued for; null when the id was never issued here. */
	lookup(itemId: string): { page: IssuedPage; record: ItemRecord } | null {
		const match = ITEM_ID.exec(itemId);
		if (!match) return null;
		const page = this.pages.get(match[1]!);
		const record = page?.records.get(itemId);
		return page && record ? { page, record } : null;
	}
}
