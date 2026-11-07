import {
	type HostCall,
	type InputProvenance,
	type ItemRecord,
	type ObservationEnvelope,
	type OperationResult,
	type PageItem,
	type PageSummary,
	type PartResult,
	type PartEventsPort,
	type PartRecordPort,
	type SiteKnowledgePort,
} from "../../../index.ts";
import type {
	Executed,
	ExecuteOptions,
	PartExecutionPort,
	PartTabPort,
} from "../ports.ts";
import type { InputGrants } from "../../grants.ts";
import { Refusal, RunEnd } from "../../errors.ts";
import type { CaptureStore } from "../capture.ts";
import { partsHelpers, type PartsHelpers } from "../core.ts";
import { pageItem } from "../../../core/parts/items.ts";
import { squash } from "../../../core/shared/text.ts";
import { ItemRegistry, pageKey } from "../registry.ts";
import type { HiddenSort } from "./sort.ts";
import type { Continuation } from "./browse.ts";
import type { PreparedCapture } from "./capture.ts";

/** Size bounds of what the model is shown (the summary says when it cut). */
export const SUMMARY_ITEMS = 40;
export const SUMMARY_HEADINGS = 8;
const CANDIDATES = 10;
/** Seconds a bot check is given to pass by itself, once. */

/** The run ends or stops: what the run loop is to be given as is. */
export class Halt extends Error {
	constructor(readonly executed: Executed) {
		super("halt");
		this.name = "Halt";
	}
}

/** The part could not do its job; the model is told why. */
export class PartFail extends Error {
	constructor(
		readonly code: string,
		readonly extra: Partial<PartResult> = {},
	) {
		super(code);
		this.name = "PartFail";
	}
}

export type Step =
	| { kind: "observation"; observation: ObservationEnvelope }
	| {
			kind: "operation";
			result: OperationResult;
			observation?: ObservationEnvelope;
	  }
	| { kind: "tabs" }
	| { kind: "refused"; code: string };

export type Body = Omit<PartResult, "part" | "resultId">;

export type PartExecutorDeps = {
	executor: PartExecutionPort;
	tabs: PartTabPort;
	/** Injected ports (the host's transcript, events and site knowledge). */
	recorder: PartRecordPort;
	events: PartEventsPort;
	knowledge: SiteKnowledgePort;
	captures: Pick<CaptureStore, "save">;
	grants: Pick<InputGrants, "find">;
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

export type Target = { record: ItemRecord; ref: string };

/**
 * What one executor's parts share, in one object that each part function receives first. The mutable fields
 * are the executor's whole state: the tab the parts work on, how many results were issued, the observation the
 * latest summary was made of, and the hidden sort choices issued so far.
 */
export type ExecutorContext = {
	readonly deps: PartExecutorDeps;
	readonly executor: PartExecutionPort;
	readonly tabs: PartTabPort;
	readonly recorder: PartRecordPort;
	readonly captures: Pick<CaptureStore, "save">;
	readonly grants: Pick<InputGrants, "find">;
	readonly core: PartsHelpers;
	readonly continuations: Map<string, Continuation>;
	preparedCapture: PreparedCapture | null;
	blocked: boolean;
	nextChoiceId: number;
	readonly registry: ItemRegistry;
	active: string | null;
	results: number;
	/** The observation the latest summary was made of: where a hidden sort control is looked for. */
	lastSeen: ObservationEnvelope | null;
	/** Sort choices the accessibility tree does not show, by the item id issued for them: the URL each leads to. */
	hiddenSorts: Map<string, HiddenSort>;
	/** Normalised page text this run has read (observations and page.read), bounded; see `notePage`. */
	seenText: string[];
	/** The URLs this run saw as a page's address or as a link on a page (`urlKey` form). */
	seenUrls: Set<string>;
};

const SEEN_TEXT_ENTRIES = 40;
const SEEN_TEXT_CHARS = 600_000;
const SEEN_LINKS = 2000;

/** A URL as compared for "was it seen": absolute, without its fragment; null for text that is not one. */
export function urlKey(raw: string, base?: string): string | null {
	try {
		const url = new URL(raw, base);
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

/**
 * Remembers what a page showed: its text (for the page-run check of R21) and the addresses it gave (its own and
 * its links). Called for every observation the host hands to a part and for every text a part reads.
 */
export function notePage(
	ctx: ExecutorContext,
	text: string | undefined,
	url?: string,
	links: readonly string[] = [],
) {
	if (text !== undefined) {
		const squashed = squash(text);
		if (squashed !== "" && !ctx.seenText.includes(squashed)) {
			ctx.seenText.push(squashed);
			while (
				ctx.seenText.length > SEEN_TEXT_ENTRIES ||
				(ctx.seenText.length > 1 &&
					ctx.seenText.reduce((n, s) => n + s.length, 0) > SEEN_TEXT_CHARS)
			)
				ctx.seenText.shift();
		}
	}
	const own = url === undefined ? null : urlKey(url);
	if (own !== null) ctx.seenUrls.add(own);
	for (const link of links) {
		const key = urlKey(link, url);
		if (key !== null) ctx.seenUrls.add(key);
	}
}

export function noteObservation(ctx: ExecutorContext, o: ObservationEnvelope) {
	// Read without issuing page ids: noting a page must not register it.
	const { records } = ctx.core.summarizePage(
		{ body: o.body, truncated: o.truncated, missing: o.missing },
		{ pageId: "p0", maxItems: SEEN_LINKS, maxHeadings: 0 },
	);
	notePage(
		ctx,
		`${o.title ?? ""}\n${o.body}`,
		o.url,
		records.flatMap((r) => (r.url === undefined ? [] : [r.url])),
	);
}

export function createContext(deps: PartExecutorDeps): ExecutorContext {
	return {
		deps,
		executor: deps.executor,
		tabs: deps.tabs,
		recorder: deps.recorder,
		captures: deps.captures,
		grants: deps.grants,
		core: deps.core ?? partsHelpers,
		continuations: new Map(),
		preparedCapture: null,
		blocked: false,
		nextChoiceId: 90000,
		registry: new ItemRegistry(),
		active: null,
		results: 0,
		lastSeen: null,
		hiddenSorts: new Map(),
		seenText: [],
		seenUrls: new Set(),
	};
}

export const toItem = (record: ItemRecord): PageItem => pageItem(record);

export const elementName = (record: Pick<ItemRecord, "role" | "name">) =>
	`${record.role} "${record.name}"`.slice(0, 200);

/** Runs `fn`, turning the host's own refusals and ends into the part's two ways out. */
export async function guard<T>(
	ctx: ExecutorContext,
	fn: () => Promise<T>,
): Promise<T> {
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
export async function step(
	ctx: ExecutorContext,
	call: HostCall,
	options?: ExecuteOptions,
): Promise<Step> {
	const executed = await ctx.executor.execute(call, options);
	if (executed.kind === "end") throw new Halt(executed);
	const { outcome } = executed;
	switch (outcome.kind) {
		case "stop":
			throw new Halt(executed);
		case "refused":
			return { kind: "refused", code: outcome.code };
		case "observation":
			noteObservation(ctx, outcome.observation);
			return { kind: "observation", observation: outcome.observation };
		case "operation":
			if (outcome.observation) noteObservation(ctx, outcome.observation);
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
export async function activeTab(ctx: ExecutorContext): Promise<string> {
	const known = ctx.active === null ? undefined : ctx.tabs.get(ctx.active);
	if (known?.status === "open") return known.tabRef;
	ctx.active = await guard(ctx, () => ctx.executor.attach());
	return ctx.active;
}

export async function observeFresh(
	ctx: ExecutorContext,
): Promise<ObservationEnvelope> {
	for (let attempt = 0; ; attempt++) {
		const tabRef = await activeTab(ctx);
		const s = await step(ctx, { kind: "observe", tabRef });
		if (s.kind === "observation") return s.observation;
		if (s.kind === "refused" && s.code === "tab_lost" && attempt === 0) {
			ctx.active = null;
			continue;
		}
		throw new PartFail(
			s.kind === "refused" ? s.code : "observation_unavailable",
		);
	}
}

export const tabOf = (o: ObservationEnvelope) =>
	o.target.kind === "tab" ? o.target.tabRef : "";
function pageIdOf(ctx: ExecutorContext, o: ObservationEnvelope) {
	return ctx.registry.pageIdFor(tabOf(o), o.url);
}

/**
 * A batch of item ids the helpers make for this observation, remembered under its page id. When the batch
 * would give an id already issued on this page to a different element (the content moved since), it is made
 * again under a new page id: an id the model holds never comes to name another element.
 */
export function batch<T extends { records: readonly ItemRecord[] }>(
	ctx: ExecutorContext,
	observation: ObservationEnvelope,
	make: (pageId: string) => T,
): T {
	const tabRef = tabOf(observation);
	let pageId = pageIdOf(ctx, observation);
	let made = make(pageId);
	if (ctx.registry.conflicts(pageId, tabRef, made.records)) {
		ctx.registry.markChanged();
		pageId = pageIdOf(ctx, observation);
		made = make(pageId);
	}
	ctx.registry.add(pageId, tabRef, observation.url ?? "", made.records);
	return made;
}

/** Issues the page id and the item ids of the observation's summary. */
export function summarize(
	ctx: ExecutorContext,
	observation: ObservationEnvelope,
): PageSummary {
	ctx.lastSeen = observation;
	const made = batch(ctx, observation, (pageId) =>
		ctx.core.summarizePage(
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
	);
	return made.summary;
}

/** Items similar to a record that is gone or ambiguous: what the model may choose from instead. */
export function candidatesFor(
	ctx: ExecutorContext,
	record: ItemRecord,
	observation: ObservationEnvelope,
): PageItem[] {
	const { records } = batch(ctx, observation, (pageId) => ({
		records: ctx.core.findItems(
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

/**
 * The record an id names, found again in this fresh observation by role, name, region and position. An id
 * the host did not issue, one of another page, or one that matches no element or several is a failure that
 * says so; nothing is chosen on the model's behalf.
 */
export function resolve(
	ctx: ExecutorContext,
	itemId: string,
	observation: ObservationEnvelope,
): Target {
	const hit = ctx.registry.lookup(itemId);
	if (!hit) throw new PartFail("item_unknown");
	if (
		hit.page.tabRef !== tabOf(observation) ||
		pageKey(hit.page.url) !== pageKey(observation.url)
	)
		throw new PartFail("item_expired", { page: summarize(ctx, observation) });
	const found = ctx.core.resolveItem(hit.record, observation.body);
	if (found.kind === "found") return { record: hit.record, ref: found.ref };
	const candidates = candidatesFor(ctx, hit.record, observation);
	throw new PartFail(
		found.kind === "none" ? "target_not_found" : "target_ambiguous",
		{ candidates },
	);
}

/** After an operation the page is observed again by the executor; one it could not observe is looked at here. */
export async function observationAfter(
	ctx: ExecutorContext,
	s: Step,
): Promise<ObservationEnvelope> {
	if (s.kind === "operation" && s.observation) return s.observation;
	return observeFresh(ctx);
}

/**
 * What follows an operation that took effect. A failure there (the new tab refused, the page not observable)
 * is `partial`, not `failed`: the operation was sent, and the model must not send it again.
 */
export async function afterSending<T>(
	ctx: ExecutorContext,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof PartFail && error.extra.status === undefined)
			throw new PartFail(error.code, { ...error.extra, status: "partial" });
		throw error;
	}
}

/** An inner operation that did not take effect is the part's failure, with the platform's code. */
export function confirmed(
	ctx: ExecutorContext,
	s: Step,
): Extract<Step, { kind: "operation" }> {
	if (s.kind === "refused") throw new PartFail(s.code);
	if (s.kind !== "operation") throw new PartFail("unexpected_outcome");
	if (s.result.status !== "confirmed")
		throw new PartFail(s.result.code ?? "operation_failed");
	return s;
}

/** An operation on the active tab's current page. */
export async function operate(
	ctx: ExecutorContext,
	command: Extract<HostCall, { kind: "operate" }>["command"],
	declaredEffect: Extract<HostCall, { kind: "operate" }>["declaredEffect"],
	extra: {
		observation?: ObservationEnvelope;
		inputProvenance?: InputProvenance;
		valueChecked?: boolean;
		recoverable?: boolean;
		/** What a granted value is for (the field's label): the host checks it against the grant's purpose. */
		grantPurpose?: string;
	} = {},
): Promise<Step> {
	const tabRef = await activeTab(ctx);
	// Whatever may have moved the page voids the ids issued so far (typing and choosing do not).
	if (
		command.action === "browser.navigate" ||
		command.action === "browser.back" ||
		command.action === "page.click" ||
		command.action === "page.wait" ||
		(command.action === "page.fill" && command.submit)
	)
		ctx.registry.markChanged();
	return step(
		ctx,
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
		extra.valueChecked || extra.recoverable || extra.grantPurpose !== undefined
			? {
					...(extra.valueChecked ? { valueChecked: true } : {}),
					...(extra.recoverable ? { recoverable: true } : {}),
					...(extra.grantPurpose !== undefined
						? { grantPurpose: extra.grantPurpose }
						: {}),
				}
			: undefined,
	);
}

/** Classification belongs to the caller's model; navigation never guesses a challenge from words. */
export async function passChallenge(
	_ctx: ExecutorContext,
	observation: ObservationEnvelope,
): Promise<ObservationEnvelope> {
	return observation;
}
