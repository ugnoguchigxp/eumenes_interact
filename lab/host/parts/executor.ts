import {
	findText,
	type FormField,
	type HostCall,
	type InputProvenance,
	type ItemRecord,
	type ObservationEnvelope,
	type OperationResult,
	type PageItem,
	type PageSummary,
	type PartCall,
	type PartResult,
	type TabView,
	type PartEventsPort,
	type PartRecordPort,
	type SiteKnowledgePort,
} from "eumenes-interact";
import type { Executed, ExecuteOptions, Executor } from "../executor.ts";
import { assertQuoted, type InputGrants } from "../grants.ts";
import type { TabRegistry } from "../tabs.ts";
import { Refusal, RunEnd } from "../types.ts";
import { captureTargetHash } from "../../scorer/captures.ts";
import { CaptureError, type CaptureStore } from "./capture.ts";
import { partsHelpers, type PartsHelpers } from "./core.ts";
import { generalSearchUrl, isChallenge, siteSearchUrl } from "./search-urls.ts";
import { ItemRegistry, pageKey } from "./registry.ts";

/**
 * The part executor of Arm 1 (plan.md §6.4): one implementation per registered part, each a deterministic
 * sequence of operations run through the host's executor. Every inner operation therefore keeps the URL policy,
 * the approval gate, the ledger (`dispatched` committed before the adapter is awaited), the stale checks and
 * the rule that an indeterminate operation is never sent again. The model sees page summaries and host-issued
 * item ids; refs never leave this module, and an id that cannot be matched to exactly one element in a fresh
 * observation is a candidate list for the model, never a guess.
 */

/** Size bounds of what the model is shown (the summary says when it cut). */
export const SUMMARY_ITEMS = 40;
export const SUMMARY_HEADINGS = 8;
const FIND_LIMIT = 20;
const SEARCH_LIST_LIMIT = 10;
const CANDIDATES = 10;
/** Seconds a bot check is given to pass by itself, once. */
const CHALLENGE_WAIT_S = 8;

/**
 * What a model may write for a checkbox or a radio button (the system text asks for on or off). Any other value
 * is refused for the model to restate: a passage such as 「不要」 is never read as a choice.
 */
const ON_WORDS = new Set([
	"on",
	"true",
	"yes",
	"1",
	"checked",
	"オン",
	"はい",
	"する",
	"あり",
]);
const OFF_WORDS = new Set([
	"off",
	"false",
	"no",
	"0",
	"unchecked",
	"オフ",
	"いいえ",
	"しない",
	"なし",
]);
/** A choice's label counts as mentioned when this many characters of it in a row appear in the request. */
const MENTION_CHARS = 4;
const sameKey = (text: string) => text.normalize("NFKC").trim().toLowerCase();

/**
 * What `item.open` may click, with the effect the part declares. In Arm 1 the part, not the model, declares the
 * effect: a link opens a page, and a button is a submission, as `form.submit` is, so it always asks first (the
 * ported gate alone lets a GET form's submit button through, which in Arm 0 the model declares as a submit).
 * Fields are for `form.fill` (its value rules), and content blocks are for reading and capturing.
 */
const OPENABLE: Readonly<Record<string, "navigation" | "submit">> = {
	link: "navigation",
	menuitem: "navigation",
	tab: "navigation",
	button: "submit",
};

/** Fields a person types into; a combobox with options is chosen from instead. */
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** The run ends or stops: what the run loop is to be given as is. */
class Halt extends Error {
	constructor(readonly executed: Executed) {
		super("halt");
		this.name = "Halt";
	}
}

/** The part could not do its job; the model is told why. */
class PartFail extends Error {
	constructor(
		readonly code: string,
		readonly extra: Partial<PartResult> = {},
	) {
		super(code);
		this.name = "PartFail";
	}
}

type Step =
	| { kind: "observation"; observation: ObservationEnvelope }
	| {
			kind: "operation";
			result: OperationResult;
			observation?: ObservationEnvelope;
	  }
	| { kind: "tabs" }
	| { kind: "refused"; code: string };

type Body = Omit<PartResult, "part" | "resultId">;

export type PartExecutorDeps = {
	executor: Pick<Executor, "execute" | "extract" | "capture" | "attach">;
	tabs: TabRegistry;
	/** Injected ports (the host's transcript, events and site knowledge). */
	recorder: PartRecordPort;
	events: PartEventsPort;
	knowledge: SiteKnowledgePort;
	captures: CaptureStore;
	grants: InputGrants;
	/** The user's request: what a typed value is checked against. */
	request: string;
	/**
	 * Verified results of earlier steps of the same request (a chain's handoff): a search word found there has
	 * a source, as one of the request has. Called at each search, so a later step sees results added since.
	 */
	sources?: () => readonly string[];
	/**
	 * The goal of this step as the plan wrote it. A plain word of it (a lowercase word or a kana/kanji word, no
	 * digits, no capital) may join a search — "earnings" in "find the earnings call" — but a name or number
	 * in it does not: those still need the request or an earlier result as their source.
	 */
	goal?: string;
	/** Defaults to the package's helpers. */
	core?: PartsHelpers;
};

const toItem = (record: ItemRecord): PageItem => ({
	item: record.item,
	role: record.role,
	name: record.name,
	...(record.region === undefined ? {} : { region: record.region }),
	...(record.url === undefined ? {} : { url: record.url }),
});

const elementName = (record: Pick<ItemRecord, "role" | "name">) =>
	`${record.role} "${record.name}"`.slice(0, 200);

const sameText = (a: string, b: string) =>
	a.normalize("NFKC").trim().toLowerCase() ===
	b.normalize("NFKC").trim().toLowerCase();

export function createPartExecutor(deps: PartExecutorDeps) {
	const { executor, tabs, recorder, captures, grants } = deps;
	const core = deps.core ?? partsHelpers;
	const registry = new ItemRegistry();
	let active: string | null = null;
	let results = 0;

	/** Runs `fn`, turning the host's own refusals and ends into the part's two ways out. */
	async function guard<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (error) {
			if (error instanceof Refusal) throw new PartFail(error.code);
			if (error instanceof RunEnd)
				throw new Halt({
					kind: "end",
					status: error.status,
					code: error.code,
				});
			throw error;
		}
	}

	/** One inner call. A stop (approval) and the end of the run leave the part at once. */
	async function step(call: HostCall, options?: ExecuteOptions): Promise<Step> {
		const executed = await executor.execute(call, options);
		if (executed.kind === "end") throw new Halt(executed);
		const { outcome } = executed;
		switch (outcome.kind) {
			case "stop":
				throw new Halt(executed);
			case "refused":
				return { kind: "refused", code: outcome.code };
			case "observation":
				return { kind: "observation", observation: outcome.observation };
			case "operation":
				return {
					kind: "operation",
					result: outcome.result,
					...(outcome.observation ? { observation: outcome.observation } : {}),
				};
			case "tabs":
				return { kind: "tabs" };
			case "part":
				return { kind: "refused", code: "unexpected_outcome" };
		}
	}

	/** The tab the parts work on: the one the run started on, or the one a part followed to. */
	async function activeTab(): Promise<string> {
		const known = active === null ? undefined : tabs.get(active);
		if (known?.status === "open") return known.tabRef;
		active = await guard(() => executor.attach());
		return active;
	}

	async function observeFresh(): Promise<ObservationEnvelope> {
		for (let attempt = 0; ; attempt++) {
			const tabRef = await activeTab();
			const s = await step({ kind: "observe", tabRef });
			if (s.kind === "observation") return s.observation;
			if (s.kind === "refused" && s.code === "tab_lost" && attempt === 0) {
				active = null;
				continue;
			}
			throw new PartFail(
				s.kind === "refused" ? s.code : "observation_unavailable",
			);
		}
	}

	const tabOf = (o: ObservationEnvelope) =>
		o.target.kind === "tab" ? o.target.tabRef : "";
	const pageIdOf = (o: ObservationEnvelope) =>
		registry.pageIdFor(tabOf(o), o.url);

	/**
	 * A batch of item ids the helpers make for this observation, remembered under its page id. When the batch
	 * would give an id already issued on this page to a different element (the content moved since), it is made
	 * again under a new page id: an id the model holds never comes to name another element.
	 */
	function batch<T extends { records: readonly ItemRecord[] }>(
		observation: ObservationEnvelope,
		make: (pageId: string) => T,
	): T {
		const tabRef = tabOf(observation);
		let pageId = pageIdOf(observation);
		let made = make(pageId);
		if (registry.conflicts(pageId, tabRef, made.records)) {
			registry.markChanged();
			pageId = pageIdOf(observation);
			made = make(pageId);
		}
		registry.add(pageId, tabRef, observation.url ?? "", made.records);
		return made;
	}

	/** Issues the page id and the item ids of the observation's summary. */
	function summarize(observation: ObservationEnvelope): PageSummary {
		return batch(observation, (pageId) =>
			core.summarizePage(
				{
					body: observation.body,
					...(observation.url === undefined ? {} : { url: observation.url }),
					...(observation.title === undefined
						? {}
						: { title: observation.title }),
					truncated: observation.truncated,
					missing: observation.missing,
				},
				{ pageId, maxItems: SUMMARY_ITEMS, maxHeadings: SUMMARY_HEADINGS },
			),
		).summary;
	}

	/** Items similar to a record that is gone or ambiguous: what the model may choose from instead. */
	function candidatesFor(
		record: ItemRecord,
		observation: ObservationEnvelope,
	): PageItem[] {
		const { records } = batch(observation, (pageId) => ({
			records: core.findItems(
				observation.body,
				pageId,
				record.name === ""
					? { text: null, role: record.role }
					: { text: record.name, role: null },
				CANDIDATES,
			),
		}));
		return records.map(toItem);
	}

	type Target = { record: ItemRecord; ref: string };

	/**
	 * The record an id names, found again in this fresh observation by role, name, region and position. An id
	 * the host did not issue, one of another page, or one that matches no element or several is a failure that
	 * says so; nothing is chosen on the model's behalf.
	 */
	function resolve(itemId: string, observation: ObservationEnvelope): Target {
		const hit = registry.lookup(itemId);
		if (!hit) throw new PartFail("item_unknown");
		if (
			hit.page.tabRef !== tabOf(observation) ||
			pageKey(hit.page.url) !== pageKey(observation.url)
		)
			throw new PartFail("item_expired", { page: summarize(observation) });
		const found = core.resolveItem(hit.record, observation.body);
		if (found.kind === "found") return { record: hit.record, ref: found.ref };
		const candidates = candidatesFor(hit.record, observation);
		throw new PartFail(
			found.kind === "none" ? "target_not_found" : "target_ambiguous",
			{ candidates },
		);
	}

	/** After an operation the page is observed again by the executor; one it could not observe is looked at here. */
	async function observationAfter(s: Step): Promise<ObservationEnvelope> {
		if (s.kind === "operation" && s.observation) return s.observation;
		return observeFresh();
	}

	/**
	 * What follows an operation that took effect. A failure there (the new tab refused, the page not observable)
	 * is `partial`, not `failed`: the operation was sent, and the model must not send it again.
	 */
	async function afterSending<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (error) {
			if (error instanceof PartFail && error.extra.status === undefined)
				throw new PartFail(error.code, { ...error.extra, status: "partial" });
			throw error;
		}
	}

	/** An inner operation that did not take effect is the part's failure, with the platform's code. */
	function confirmed(s: Step): Extract<Step, { kind: "operation" }> {
		if (s.kind === "refused") throw new PartFail(s.code);
		if (s.kind !== "operation") throw new PartFail("unexpected_outcome");
		if (s.result.status !== "confirmed")
			throw new PartFail(s.result.code ?? "operation_failed");
		return s;
	}

	/** An operation on the active tab's current page. */
	async function operate(
		command: Extract<HostCall, { kind: "operate" }>["command"],
		declaredEffect: Extract<HostCall, { kind: "operate" }>["declaredEffect"],
		extra: {
			observation?: ObservationEnvelope;
			inputProvenance?: InputProvenance;
			valueChecked?: boolean;
			recoverable?: boolean;
		} = {},
	): Promise<Step> {
		const tabRef = await activeTab();
		// Whatever may have moved the page voids the ids issued so far (typing and choosing do not).
		if (
			command.action === "browser.navigate" ||
			command.action === "browser.back" ||
			command.action === "page.click" ||
			command.action === "page.wait" ||
			(command.action === "page.fill" && command.submit)
		)
			registry.markChanged();
		return step(
			{
				kind: "operate",
				tabRef,
				...(extra.observation
					? { observationRef: extra.observation.observationRef }
					: {}),
				command,
				declaredEffect,
				...(extra.inputProvenance
					? { inputProvenance: extra.inputProvenance }
					: {}),
			},
			extra.valueChecked || extra.recoverable
				? {
						...(extra.valueChecked ? { valueChecked: true } : {}),
						...(extra.recoverable ? { recoverable: true } : {}),
					}
				: undefined,
		);
	}

	/**
	 * Clicks an element. A click may open a page in a new tab: the tab list is compared before and after, the
	 * new tab is selected and observed, and later parts work on it. Only Arm 1 does this; Arm 0 stays as Eumenes.
	 */
	async function click(
		target: Target,
		observation: ObservationEnvelope,
		effect: "navigation" | "submit",
	): Promise<ObservationEnvelope> {
		const before = new Set(tabs.open().map((t) => t.tabRef));
		const s = confirmed(
			await operate(
				{
					action: "page.click",
					targetRef: target.ref,
					element: elementName(target.record),
				},
				effect,
				{ observation },
			),
		);
		return afterSending(async () => {
			const opened = tabs.open().filter((t) => !before.has(t.tabRef));
			const fresh = opened.at(-1);
			if (fresh) {
				const selected = await step({
					kind: "tabs.select",
					tabRef: fresh.tabRef,
				});
				if (selected.kind === "refused") throw new PartFail(selected.code);
				if (selected.kind !== "operation" || !selected.observation)
					throw new PartFail("observation_unavailable");
				active = fresh.tabRef;
				return selected.observation;
			}
			return observationAfter(s);
		});
	}

	// ---- the parts

	async function pageOpen(url: string): Promise<Body> {
		const s = confirmed(
			await operate({ action: "browser.navigate", url }, "navigation"),
		);
		const landed = await passChallenge(
			await afterSending(() => observationAfter(s)),
		);
		return { status: "completed", page: summarize(landed) };
	}

	async function pageBack(): Promise<Body> {
		const s = confirmed(
			await operate({ action: "browser.back" }, "navigation"),
		);
		return {
			status: "completed",
			page: summarize(await afterSending(() => observationAfter(s))),
		};
	}

	/**
	 * Every word of the query must have a source: a passage of the request (the same rule as a typed value), or
	 * a passage of a verified result of an earlier step of the same request (a handoff, e.g. the ticker found in
	 * step 1 searched in step 2). A word with neither — a guess — is refused.
	 */
	function querySourced(query: string): boolean {
		const words = query.split(/[\s　]+/).filter(Boolean);
		if (words.length === 0) return false;
		const texts = [deps.request, ...(deps.sources?.() ?? [])];
		const goal = deps.goal ?? "";
		return words.every(
			(word) =>
				(PLAIN_WORD.test(word) &&
					goal
						.toLowerCase()
						.split(/[^\p{L}\p{N}ー-]+/u)
						.includes(word)) ||
				(PLAIN_WORD.test(word) &&
					/[^a-z-]/.test(word) &&
					goal.includes(word)) ||
				texts.some((text) => {
					if (word.length === 1) return text.includes(word);
					try {
						assertQuoted(word, word, text);
						return true;
					} catch {
						return false;
					}
				}),
		);
	}

	/** A common word: lowercase Latin, or kana/kanji; never a digit or a capital (names and numbers are entities). */
	const PLAIN_WORD =
		/^(?:[a-z][a-z-]{1,}|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]{1,8})$/u;

	const PAGING =
		/^(?:\d{1,3}|[<>«»‹›]+|next|prev(?:ious)?|次(?:へ|のページ)?|前(?:へ|のページ)?|最初|最後|もっと見る)[\s>»›]*$/i;

	const SEARCH_NAME = /search|検索|keyword|キーワード|query|探す|find/i;

	/**
	 * The search field: the site knowledge's `search.query`, else the page's search boxes, comboboxes and text
	 * boxes named for search. With several, the one in a search region comes first, then one named for search,
	 * then the first in document order: never an arbitrary pick, and never a field of a login or other form.
	 */
	function searchField(observation: ObservationEnvelope): Target | null {
		if (observation.url !== undefined) {
			const found = deps.knowledge.resolve(
				observation.url,
				observation.body,
				"search.query",
			);
			if (found)
				return {
					ref: found.ref,
					record: {
						item: "p0.i0",
						role: found.role,
						name: found.name,
						ref: found.ref,
						nth: 0,
						count: 1,
					},
				};
		}
		const { records } = batch(observation, (pageId) => ({
			records: (["searchbox", "combobox", "textbox"] as const).flatMap((role) =>
				core.findItems(observation.body, pageId, { text: null, role }, 10),
			),
		}));
		const fields = records.filter(
			(r) =>
				r.role === "searchbox" ||
				SEARCH_NAME.test(r.name) ||
				r.region === "search" ||
				(r.role === "combobox" && r.name === ""),
		);
		const rank = (r: ItemRecord) =>
			r.region === "search"
				? 0
				: r.role === "searchbox"
					? 1
					: SEARCH_NAME.test(r.name)
						? 2
						: 3;
		const best = [...fields].sort((x, y) => rank(x) - rank(y))[0];
		return best ? { record: best, ref: best.ref } : null;
	}

	/** A button that only shows the search box (a magnifier in the header). */
	function revealButton(observation: ObservationEnvelope): Target | null {
		const { records } = batch(observation, (pageId) => ({
			records: core.findItems(
				observation.body,
				pageId,
				{ text: null, role: "button" },
				40,
			),
		}));
		const button = records.find((r) => SEARCH_NAME.test(r.name));
		return button ? { record: button, ref: button.ref } : null;
	}

	/**
	 * A bot check (Cloudflare and the like) is waited out once, a few seconds, without clicking anything; one
	 * that stays is `site_blocked`. It is never solved or bypassed.
	 */
	async function passChallenge(
		observation: ObservationEnvelope,
	): Promise<ObservationEnvelope> {
		if (!isChallenge(observation.title, observation.body)) return observation;
		await operate({ action: "page.wait", seconds: CHALLENGE_WAIT_S }, "none");
		const again = await observeFresh();
		if (isChallenge(again.title, again.body))
			throw new PartFail("site_blocked", { page: summarize(again) });
		return again;
	}

	/** Types the query into the field and submits; null when the field did not take it. */
	async function typeSearch(
		field: Target,
		observation: ObservationEnvelope,
		query: string,
	): Promise<ObservationEnvelope | null> {
		const s = await operate(
			{
				action: "page.fill",
				targetRef: field.ref,
				element: elementName(field.record),
				text: query,
				submit: true,
			},
			"input",
			{ observation, valueChecked: true, recoverable: true },
		);
		if (s.kind !== "operation") return null;
		if (s.result.status !== "confirmed") return null;
		return afterSending(() => observationAfter(s));
	}

	async function openUrl(url: string): Promise<ObservationEnvelope | null> {
		const s = await operate({ action: "browser.navigate", url }, "navigation");
		if (s.kind !== "operation" || s.result.status !== "confirmed") return null;
		return afterSending(() => observationAfter(s));
	}

	async function siteSearch(query: string): Promise<Body> {
		if (!querySourced(query)) throw new PartFail("query_not_in_request");
		const start = await passChallenge(await observeFresh());
		const origin = start.url ?? "";
		const tried: string[] = [];
		let after: ObservationEnvelope | null = null;
		// 1. The page's own search box. 2. The site's own search page the host knows. 3. A general engine, only
		// where the policy allows it. 4. A button that shows a hidden box: last, because a button click asks the
		// user's approval (no site is exempt), and a URL that needs none is preferred.
		let field = searchField(start);
		let page = start;
		let landedDirect = false;
		if (field) {
			tried.push("box");
			after = await typeSearch(field, page, query);
			// The box took the text but the page did not move (a script-only box, a language it ignores): no search
			// happened, so the next way is tried rather than the unchanged page being reported as results.
			if (after && after.url === start.url) after = null;
		}
		if (!after) {
			const known = siteSearchUrl(origin, query);
			if (known) {
				tried.push("site_url");
				after = await openUrl(known);
				// The site went straight to the one thing searched for (a quote, an article): that is a result.
				if (
					after?.url &&
					new URL(after.url).pathname !== new URL(known).pathname
				)
					landedDirect = true;
			}
		}
		if (!after) {
			const general = generalSearchUrl(origin, query);
			if (general) {
				tried.push("general");
				// A general engine outside the run's allowed origins is refused by the policy: then nothing is opened.
				after = await openUrl(general);
			}
		}
		if (!after) {
			const button = revealButton(start);
			if (button) {
				tried.push("reveal");
				const clicked = await operate(
					{
						action: "page.click",
						targetRef: button.ref,
						element: elementName(button.record),
					},
					"navigation",
					{ observation: start },
				);
				if (
					clicked.kind === "operation" &&
					clicked.result.status === "confirmed"
				) {
					page = await observationAfter(clicked);
					field = searchField(page);
					if (field) after = await typeSearch(field, page, query);
				}
			}
		}
		if (!after) {
			throw new PartFail("no_search_box", { page: summarize(page) });
		}
		after = await passChallenge(after);
		const summary = summarize(after);
		const listed = batch(after, (pageId) =>
			core.listEntries(after.body, pageId, "results", SEARCH_LIST_LIMIT),
		);
		// "Skip to main content" links are on every page, results or not: they never count as a result.
		const kept = listed.entries.filter(
			(e) => !/^skip (to|navigation)\b/i.test(e.title.trim()),
		);
		// Page numbers and next/prev links are listed where the page puts them, often above the results: they
		// go after the real results, and alone they are not results.
		const paging = kept.filter((e) => PAGING.test(e.title.trim()));
		const real = kept.filter((e) => !PAGING.test(e.title.trim()));
		const results = real.length ? [...real, ...paging] : [];
		if (results.length === 0) {
			if (landedDirect) return { status: "completed", page: summary };
			throw new PartFail("zero_results", { status: "partial", page: summary });
		}
		return {
			status: "completed",
			page: summary,
			list: {
				kind: "results",
				entries: results,
				truncated: listed.truncated,
			},
		};
	}

	async function pageFind(
		text: string | null,
		role: string | null,
	): Promise<Body> {
		if (text === null && role === null) throw new PartFail("invalid_args");
		const observation = await observeFresh();
		const { records } = batch(observation, (pageId) => ({
			records: core.findItems(
				observation.body,
				pageId,
				{ text, role },
				FIND_LIMIT,
			),
		}));
		if (records.length > 0)
			return { status: "completed", candidates: records.map(toItem) };
		// No item is named so: the text may be in the page's body (a paragraph, a cell). The hits come back as
		// read text, each with the item nearest to it.
		if (text !== null) {
			const found = batch(observation, (pageId) =>
				findText(observation.body, pageId, text, FIND_LIMIT),
			);
			if (found.hits.length) {
				const lines = found.hits.map((h) =>
					h.item ? `[${h.item}] ${h.text}` : h.text,
				);
				const body = lines.join("\n");
				return {
					status: "completed",
					candidates: [
						...new Map(found.records.map((r) => [r.item, r])).values(),
					].map(toItem),
					read: { text: body, charCount: body.length, truncated: false },
				};
			}
		}
		throw new PartFail("target_not_found", { candidates: [] });
	}

	async function itemOpen(itemId: string): Promise<Body> {
		const observation = await observeFresh();
		const target = resolve(itemId, observation);
		const effect = OPENABLE[target.record.role];
		if (effect === undefined) throw new PartFail("item_not_openable");
		// A link may land on a bot check (Cloudflare's "Just a moment..."): waited out once, else site_blocked.
		const after = await passChallenge(await click(target, observation, effect));
		return { status: "completed", page: summarize(after) };
	}

	async function pageWait(
		text: string | null,
		seconds: number | null,
	): Promise<Body> {
		if (text === null && seconds === null) throw new PartFail("invalid_args");
		const s = confirmed(
			await operate(
				text !== null
					? { action: "page.wait", text }
					: { action: "page.wait", seconds: seconds! },
				"none",
			),
		);
		return { status: "completed", page: summarize(await observationAfter(s)) };
	}

	async function pageRead(
		itemId: string | null,
		maxChars: number,
	): Promise<Body> {
		let ref: string | null = null;
		let observationRef: string | undefined;
		if (itemId !== null) {
			const observation = await observeFresh();
			ref = resolve(itemId, observation).ref;
			observationRef = observation.observationRef;
		}
		const tabRef = await activeTab();
		const content = await guard(() =>
			executor.extract(tabRef, observationRef, ref, maxChars),
		);
		const text = content.text.slice(0, maxChars);
		return {
			status: "completed",
			read: {
				text,
				charCount: content.charCount,
				truncated: content.truncated || text.length < content.text.length,
				...(content.url === undefined ? {} : { url: content.url }),
				...(content.title === undefined ? {} : { title: content.title }),
			},
		};
	}

	async function pageList(
		kind: "results" | "table" | "links",
		limit: number,
	): Promise<Body> {
		const observation = await observeFresh();
		const listed = batch(observation, (pageId) =>
			core.listEntries(observation.body, pageId, kind, limit),
		);
		if (listed.entries.length === 0)
			throw new PartFail("no_entries", {
				list: { kind, entries: [], truncated: false },
			});
		return {
			status: "completed",
			list: { kind, entries: listed.entries, truncated: listed.truncated },
		};
	}

	async function pageCapture(
		range: "viewport" | "full" | "item",
		itemId: string | null,
	): Promise<Body> {
		let ref: string | null = null;
		let observationRef: string | undefined;
		let target: ItemRecord | undefined;
		if (range === "item") {
			if (itemId === null) throw new PartFail("item_required");
			const observation = await observeFresh();
			const found = resolve(itemId, observation);
			ref = found.ref;
			target = found.record;
			observationRef = observation.observationRef;
		}
		const tabRef = await activeTab();
		const image = await guard(() =>
			executor.capture(tabRef, observationRef, range, ref),
		);
		let saved;
		try {
			saved = await captures.save(range, image);
		} catch (error) {
			throw new PartFail(
				error instanceof CaptureError ? error.code : "capture_write_failed",
			);
		}
		recorder.captureSaved({
			...saved,
			...(target
				? {
						target: {
							role: target.role,
							nameHash: captureTargetHash(target.name),
						},
					}
				: {}),
		});
		deps.events.event("capture.saved", {});
		return {
			status: "completed",
			capture: {
				captureId: saved.captureId,
				width: saved.width,
				height: saved.height,
				fileName: saved.fileName,
				mediaType: saved.mediaType,
			},
		};
	}

	async function formInspect(formId: string | null): Promise<Body> {
		const observation = await observeFresh();
		const form = formId === null ? null : resolve(formId, observation).record;
		const found = batch(observation, (pageId) =>
			core.formFields(observation.body, pageId, form),
		);
		return {
			status: "completed",
			form: { fields: found.fields, submit: found.submit },
		};
	}

	/** What the field is, as the helpers describe it (every field of the page), matched to the element by its ref. */
	function fieldOf(
		observation: ObservationEnvelope,
		ref: string,
	): FormField | undefined {
		const found = core.formFields(observation.body, "p0", "page");
		const record = found.records.find((r) => r.ref === ref);
		return record
			? found.fields.find((f) => f.item === record.item)
			: undefined;
	}

	/** Where a typed value comes from: a passage of the request, or a value the user approved for this site. */
	function provenanceOf(
		value: string,
		pageUrl: string,
	): InputProvenance | null {
		try {
			assertQuoted(value, value, deps.request);
			return { kind: "request_quote", quote: value };
		} catch {
			// Not a passage of the request.
		}
		const ref = grants.find(value, pageUrl);
		return ref === null ? null : { kind: "grant", inputValueRef: ref };
	}

	/** Whether the text is a passage of the request (the rule for a typed value). */
	function quoted(text: string): boolean {
		try {
			assertQuoted(text, text, deps.request);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Whether the request mentions a choice: a run of its label's characters appears in the request. Whether the
	 * user wants it on or off is the model's to say (on or off); the host only refuses a choice the request never
	 * touches.
	 */
	function mentioned(label: string): boolean {
		const fold = (text: string) =>
			text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
		const said = fold(deps.request);
		const name = fold(label);
		if (name === "") return false;
		const n = Math.min(name.length, MENTION_CHARS);
		for (let i = 0; i + n <= name.length; i++)
			if (said.includes(name.slice(i, i + n))) return true;
		return false;
	}

	type FillResult = NonNullable<PartResult["fill"]>[number];

	async function fillOne(
		field: { item: string; value: string },
		observation: ObservationEnvelope,
	): Promise<{
		result: FillResult;
		observation: ObservationEnvelope | null;
		stop?: string;
	}> {
		const refused = (code: string): FillResult => ({
			item: field.item,
			status: "refused",
			code,
		});
		let target: Target;
		try {
			target = resolve(field.item, observation);
		} catch (error) {
			if (error instanceof PartFail)
				return { result: refused(error.code), observation };
			throw error;
		}
		const info = fieldOf(observation, target.ref);
		const options = info?.options ?? [];
		const kind = info?.kind ?? target.record.role;
		const filled = (): {
			result: FillResult;
			observation: ObservationEnvelope;
		} => ({
			result: { item: field.item, status: "filled" },
			observation,
		});
		const needsInput = () => ({
			result: {
				item: field.item,
				status: "needs_input" as const,
				code: "value_source",
			},
			observation,
		});
		const element = elementName(target.record);
		let command: Parameters<typeof operate>[0];
		let provenance: InputProvenance | undefined;
		if (options.length > 0) {
			// The option is the page's; the choice must be the user's. The value may be the request's own words for
			// it (「11月21日」 for 「11月21日（土）」): the one option that contains them is chosen, never one of several.
			const exact = options.find((o) => sameText(o, field.value));
			const wanted = sameKey(field.value);
			const containing =
				wanted === "" ? [] : options.filter((o) => sameKey(o).includes(wanted));
			const option =
				exact ?? (containing.length === 1 ? containing[0] : undefined);
			if (option === undefined)
				return {
					result: refused(
						containing.length > 1 ? "option_ambiguous" : "option_not_found",
					),
					observation,
				};
			if (!quoted(field.value) && !mentioned(option)) return needsInput();
			command = {
				action: "page.select",
				targetRef: target.ref,
				element,
				values: [option],
			};
		} else if (kind === "checkbox" || kind === "radio") {
			// A choice is made (or undone) by clicking, from its current state. The value is on or off; anything
			// else is the model's to restate. Choosing needs the request to mention the choice; clearing a box only
			// removes something, so it needs none.
			const word = sameKey(field.value);
			const on = ON_WORDS.has(word);
			if (!on && !OFF_WORDS.has(word))
				return { result: refused("choice_value"), observation };
			if (info === undefined)
				return { result: refused("field_unknown"), observation };
			if (!on) {
				if (kind === "radio")
					return { result: refused("cannot_uncheck"), observation };
				if (!info.filled) return filled();
			} else {
				if (!mentioned(info.label || target.record.name)) return needsInput();
				if (info.filled) return filled();
			}
			command = { action: "page.click", targetRef: target.ref, element };
		} else if (TEXT_ROLES.has(target.record.role)) {
			const found = provenanceOf(field.value, observation.url ?? "");
			if (found === null) return needsInput();
			provenance = found;
			command = {
				action: "page.fill",
				targetRef: target.ref,
				element,
				text: field.value,
				submit: false,
			};
		} else return { result: refused("unsupported_field"), observation };
		const s = await operate(command, "input", {
			observation,
			...(provenance ? { inputProvenance: provenance } : {}),
		});
		if (s.kind === "refused") return { result: refused(s.code), observation };
		if (s.kind !== "operation")
			return { result: refused("unexpected_outcome"), observation };
		if (s.result.status !== "confirmed")
			return {
				result: refused(s.result.code ?? "operation_failed"),
				observation,
			};
		try {
			return {
				result: { item: field.item, status: "filled" },
				observation: await observationAfter(s),
			};
		} catch (error) {
			// The value reached the page; only the look after it failed. The fill stops here, as partial.
			if (error instanceof PartFail)
				return {
					result: { item: field.item, status: "filled" },
					observation: null,
					stop: error.code,
				};
			throw error;
		}
	}

	async function formFill(
		fields: { item: string; value: string }[],
	): Promise<Body> {
		let observation = await observeFresh();
		const fill: FillResult[] = [];
		for (const field of fields) {
			const done = await fillOne(field, observation);
			fill.push(done.result);
			if (done.observation === null)
				return {
					status: "partial",
					code: done.stop ?? "observation_unavailable",
					fill,
				};
			observation = done.observation;
		}
		const filled = fill.filter((f) => f.status === "filled").length;
		const first = fill.find((f) => f.status !== "filled");
		return {
			status:
				filled === fill.length
					? "completed"
					: filled > 0
						? "partial"
						: "failed",
			...(first?.code === undefined ? {} : { code: first.code }),
			fill,
		};
	}

	async function formSubmit(buttonId: string): Promise<Body> {
		const observation = await observeFresh();
		const target = resolve(buttonId, observation);
		// A submission always asks first (the declared effect): nothing is sent until the user allows it.
		const after = await click(target, observation, "submit");
		return { status: "completed", page: summarize(after) };
	}

	async function dispatch(call: PartCall): Promise<Body> {
		switch (call.part) {
			case "page.open":
				return pageOpen(call.args.url);
			case "page.back":
				return pageBack();
			case "site.search":
				return siteSearch(call.args.query);
			case "page.find":
				return pageFind(call.args.text, call.args.role);
			case "item.open":
				return itemOpen(call.args.item);
			case "page.wait":
				return pageWait(call.args.text, call.args.seconds);
			case "page.read":
				return pageRead(call.args.target, call.args.maxChars);
			case "page.list":
				return pageList(call.args.kind, call.args.limit);
			case "page.capture":
				return pageCapture(call.args.range, call.args.item);
			case "form.inspect":
				return formInspect(call.args.form);
			case "form.fill":
				return formFill(call.args.fields);
			case "form.submit":
				return formSubmit(call.args.button);
			case "done":
			case "ask":
				// The core turns these into the end of the run; they never reach the host.
				throw new PartFail("not_executable");
		}
	}

	const finish = (part: PartCall["part"], body: Body): PartResult => ({
		part,
		resultId: `r${++results}`,
		...body,
	});

	/**
	 * Runs one part. The result is what the model is shown; a stop for approval and the end of the run come back
	 * as the run loop's own outcomes. The transcript gets the part's name and argument names, and its status.
	 */
	async function run(call: PartCall): Promise<Executed> {
		recorder.partCall(call.part, Object.keys(call.args));
		let executed: Executed;
		let status: PartResult["status"];
		let code: string | undefined;
		try {
			const result = finish(call.part, await dispatch(call));
			executed = { kind: "outcome", outcome: { kind: "part", result } };
			status = result.status;
			code = result.code;
		} catch (error) {
			if (error instanceof PartFail) {
				const result = finish(call.part, {
					status: "failed",
					code: error.code,
					...error.extra,
				});
				executed = { kind: "outcome", outcome: { kind: "part", result } };
				status = result.status;
				code = error.code;
			} else if (error instanceof Halt) {
				executed = error.executed;
				if (executed.kind === "end") {
					status =
						executed.status === "indeterminate" ? "indeterminate" : "failed";
					code = executed.code;
				} else {
					status = "needs_approval";
					code =
						executed.outcome.kind === "stop"
							? executed.outcome.code
							: undefined;
				}
			} else throw error;
		}
		recorder.partResult(call.part, status, code);
		deps.events.event("part.executed", { code: code ?? status });
		return executed;
	}

	/**
	 * The page the run starts on, as the model first sees it (the opening observation the host took when it
	 * opened the start page): the first page summary and the tab the parts work on.
	 */
	function begin(first: {
		tabs: readonly TabView[];
		observation: ObservationEnvelope;
	}): PageSummary {
		active = tabOf(first.observation) || null;
		return summarize(first.observation);
	}

	return { run, begin };
}
