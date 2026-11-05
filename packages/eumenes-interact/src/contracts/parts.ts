import { z } from "zod";
import type { RawObservation } from "./observation.ts";

/**
 * Parts (plan.md §6.4, Arm 1): the AI composes registered parts as JSON, one call per inference, like
 * OpenUI composes registered components. Concrete operations (refs, Playwright MCP tools, waits, following
 * a new tab) stay inside the part implementations. The AI never sees refs or raw snapshots: it sees page
 * summaries and refers to elements by host-issued item ids.
 *
 * The schema is written for Claude structured outputs: every object is closed, optional values are
 * required-but-nullable, and range constraints are checked client-side by zod (not in the JSON Schema).
 * The pure functions implementing `PartsCoreApi` live in `src/core/parts/`.
 */

/** A host-issued item id (`<page>.i<n>`, e.g. `p3.i12`). Opaque to the AI; valid until the page changes. */
export const itemIdSchema = z.string().regex(/^p\d{1,6}\.i\d{1,5}$/);

export const PART_NAMES = [
	"page.open",
	"page.back",
	"site.search",
	"page.find",
	"item.open",
	"page.wait",
	"page.read",
	"page.list",
	"page.capture",
	"form.inspect",
	"form.fill",
	"form.submit",
	"done",
	"ask",
] as const;
export type PartName = (typeof PART_NAMES)[number];

const call = <N extends PartName, A extends z.ZodRawShape>(name: N, args: A) =>
	z.strictObject({ part: z.literal(name), args: z.strictObject(args) });

export const partCallSchema = z.discriminatedUnion("part", [
	call("page.open", { url: z.string().max(2048) }),
	call("page.back", {}),
	call("site.search", { query: z.string().min(1).max(200) }),
	call("page.find", {
		text: z.string().max(200).nullable(),
		role: z.string().max(40).nullable(),
	}),
	call("item.open", { item: itemIdSchema }),
	call("page.wait", {
		text: z.string().max(200).nullable(),
		seconds: z.number().min(0.1).max(30).nullable(),
	}),
	call("page.read", {
		target: itemIdSchema.nullable(),
		maxChars: z.number().int().min(100).max(50000),
	}),
	call("page.list", {
		kind: z.enum(["results", "table", "links"]),
		limit: z.number().int().min(1).max(50),
	}),
	call("page.capture", {
		range: z.enum(["viewport", "full", "item"]),
		item: itemIdSchema.nullable(),
	}),
	call("form.inspect", { form: itemIdSchema.nullable() }),
	call("form.fill", {
		fields: z
			.array(
				z.strictObject({
					item: itemIdSchema,
					value: z.string().max(2000),
					quote: z
						.string()
						.min(1)
						.max(2000)
						.nullable()
						.optional()
						.describe(
							"選択を根拠付ける元の依頼の引用。表示ラベルと依頼の表現が異なるときに提示。不要ならnull。",
						),
				}),
			)
			.min(1)
			.max(30),
	}),
	call("form.submit", { button: itemIdSchema }),
	call("done", {
		answer: z.string().min(1).max(4000),
		evidence: z.array(z.string().max(40)).max(16),
		outcome: z.enum(["achieved", "partial", "unmet"]),
		basis: z.enum(["observed", "response"]),
	}),
	call("ask", { question: z.string().min(1).max(1000) }),
]);
export type PartCall = z.infer<typeof partCallSchema>;

export type PartStatus =
	"completed" | "partial" | "failed" | "needs_approval" | "indeterminate";

/** An element as the AI sees it. */
export type PageItem = {
	item: string;
	role: string;
	name: string;
	/** The landmark or heading the item sits under, when known. */
	region?: string;
	/** Link target, when the element is a link. */
	url?: string;
};

/** What the AI sees of a page instead of the raw snapshot; size-bounded. */
export type PageSummary = {
	/** Host-issued page id (`p<n>`); item ids of this page start with it. */
	page: string;
	url?: string;
	title?: string;
	headings: string[];
	regions: string[];
	items: PageItem[];
	/** Items found before the cap; `items.length` may be smaller. */
	itemCount: number;
	truncated: boolean;
};

export type ListEntry = {
	item?: string;
	title: string;
	url?: string;
	text?: string;
};

export type FormField = {
	item: string;
	label: string;
	/** textbox, searchbox, combobox, checkbox, radio, … (the snapshot role). */
	kind: string;
	required?: boolean;
	options?: string[];
	filled: boolean;
};

/** One part's result as the AI and the transcript see it. Page text is data, never instructions. */
export type PartResult = {
	part: PartName;
	status: PartStatus;
	/** Fixed classification code when not completed (e.g. `target_not_found`, `approval_required`). */
	code?: string;
	/** Host-issued id the AI may cite as evidence in `done`. */
	resultId: string;
	page?: PageSummary;
	candidates?: PageItem[];
	list?: {
		kind: "results" | "table" | "links";
		entries: ListEntry[];
		truncated: boolean;
	};
	read?: {
		text: string;
		charCount: number;
		truncated: boolean;
		url?: string;
		title?: string;
	};
	capture?: {
		captureId: string;
		width: number;
		height: number;
		fileName: string;
		mediaType: string;
	};
	form?: { fields: FormField[]; submit: PageItem[] };
	fill?: {
		item: string;
		status: "filled" | "refused" | "needs_input";
		code?: string;
	}[];
	/** Set when the part stopped for the user's approval; nothing was sent. */
	approval?: { action: string; element?: string; url?: string };
};

/** A page item with what the host needs to act on it again; never shown to the AI. */
export type ItemRecord = PageItem & {
	/** The platform ref in the snapshot the record was made from. */
	ref: string;
	/** Index among elements with the same role, name and region in that snapshot (for re-resolution). */
	nth: number;
	/** How many elements had that role, name and region in that snapshot; `nth` is only meaningful while it holds. */
	count: number;
};

export type ItemResolution =
	| { kind: "found"; ref: string }
	| { kind: "none" }
	| { kind: "ambiguous"; candidates: PageItem[] };

/** Pure functions over snapshot text (both Playwright MCP and bracketed-attribute formats). */
export type PartsCoreApi = {
	summarizePage(
		raw: RawObservation,
		options: { pageId: string; maxItems: number; maxHeadings: number },
	): { summary: PageSummary; records: ItemRecord[] };
	/** Re-finds a record in a newer snapshot of the same page by role, name, region and nth. */
	resolveItem(record: ItemRecord, body: string): ItemResolution;
	findItems(
		body: string,
		pageId: string,
		query: { text: string | null; role: string | null },
		limit: number,
	): ItemRecord[];
	listEntries(
		body: string,
		pageId: string,
		kind: "results" | "table" | "links",
		limit: number,
	): { entries: ListEntry[]; records: ItemRecord[]; truncated: boolean };
	/**
	 * The fields and buttons of a form. `form`: a form item, found again by role, name, region and position (a
	 * form that cannot be found has no fields); null: the page's only form, or the whole page when it has several
	 * forms or none (then its main region, when it has one); "page": every field of the page.
	 */
	formFields(
		body: string,
		pageId: string,
		form: ItemRecord | null | "page",
	): { fields: FormField[]; submit: PageItem[]; records: ItemRecord[] };
	/** The structured-output JSON Schema of `partCallSchema` (closed objects, no range keywords). */
	partCallJsonSchema(): Record<string, unknown>;
};
