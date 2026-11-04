import type { PlatformAdapter } from "eumenes-interact";
import {
	budgetCheck,
	planBudget,
	planSteps,
	type Plan,
	type PlanStep,
} from "eumenes-collaboration";
import type { TrialCase } from "./types.ts";

/**
 * One request of several steps, run on one browser on the user's behalf (2026-11-04). The collaboration
 * planner splits the request; each browser step is an ordinary trial on the same session, given the earlier
 * steps' results; a summary step is written from those results without a browser. A step whose result is the
 * screen (play, show) leaves the browser open after the chain returns, until the user says it is done or the
 * idle timeout passes (`DEFAULT_KEEP_OPEN_IDLE_S`).
 */

/** Seconds a kept browser stays open with no word from the user. `--keep-open-idle` changes it. */
export const DEFAULT_KEEP_OPEN_IDLE_S = 600;

/**
 * Sites a step may name, with where it starts and the origins it may visit. The general search engine is
 * allowed on every step: `site.search` falls back to it (site-scoped) when a site has no usable box.
 */
export const CHAIN_SITES: readonly {
	pattern: RegExp;
	start: string;
	origins: string[];
}[] = [
	{
		pattern: /google\s*finance|グーグル\s*ファイナンス/iu,
		start: "https://www.google.com/finance/",
		origins: ["https://www.google.com"],
	},
	{
		pattern: /youtube|ユーチューブ/iu,
		start: "https://www.youtube.com/",
		origins: ["https://www.youtube.com"],
	},
	{
		pattern: /wikipedia|ウィキペディア/iu,
		start: "https://ja.wikipedia.org/",
		origins: ["https://ja.wikipedia.org", "https://en.wikipedia.org"],
	},
	{
		pattern: /arxiv/iu,
		start: "https://arxiv.org/",
		origins: ["https://arxiv.org"],
	},
	{
		pattern: /github/iu,
		start: "https://github.com/",
		origins: ["https://github.com"],
	},
	{
		pattern: /\bnpm\b/iu,
		start: "https://www.npmjs.com/",
		origins: ["https://www.npmjs.com"],
	},
	{
		pattern: /\bmdn\b/iu,
		start: "https://developer.mozilla.org/ja/",
		origins: ["https://developer.mozilla.org"],
	},
	{
		pattern: /open\s*library/iu,
		start: "https://openlibrary.org/",
		origins: ["https://openlibrary.org"],
	},
	{
		pattern: /openstreetmap|osm/iu,
		start: "https://www.openstreetmap.org/",
		origins: ["https://www.openstreetmap.org"],
	},
	{
		pattern: /python\s*(?:公式)?\s*(?:docs|ドキュメント)/iu,
		start: "https://docs.python.org/ja/3/",
		origins: ["https://docs.python.org"],
	},
	{
		pattern: /tenki\.jp|tenki/iu,
		start: "https://tenki.jp/",
		origins: ["https://tenki.jp"],
	},
	{
		pattern: /hacker\s*news/iu,
		start: "https://news.ycombinator.com/",
		origins: ["https://news.ycombinator.com"],
	},
	{
		pattern: /world\s*bank|世界銀行/iu,
		start: "https://data.worldbank.org/",
		origins: ["https://data.worldbank.org"],
	},
	{
		pattern: /pypi/iu,
		start: "https://pypi.org/",
		origins: ["https://pypi.org"],
	},
	{
		pattern: /stack\s*overflow/iu,
		start: "https://stackoverflow.com/",
		origins: ["https://stackoverflow.com"],
	},
];

export const GENERAL_SEARCH_ORIGIN = "https://html.duckduckgo.com";

export type ChainStepCase = { step: PlanStep; def: TrialCase | null };

/** The site a step names, else the one the step before it used (「そのページで…」). */
export function chainCases(
	plan: Plan,
	request: string,
	results: ReadonlyMap<string, string>,
	maxModelCalls: number,
): ChainStepCase[] {
	let previous: (typeof CHAIN_SITES)[number] | undefined;
	return plan.steps.map((step) => {
		if (!step.needsBrowser) return { step, def: null };
		const site = CHAIN_SITES.find((s) => s.pattern.test(step.goal)) ?? previous;
		if (!site) throw new Error(`step_site_unknown:${step.id}`);
		previous = site;
		return {
			step,
			def: {
				id: `chain-${step.id}`,
				split: "live",
				category: "live",
				variant: "live",
				note: "chain step",
				request: stepRequest(step, request, results),
				start: site.start,
				allowedOrigins: [...site.origins, GENERAL_SEARCH_ORIGIN],
				budget: { maxModelCalls },
				approvalScript: { decision: "deny" },
			},
		};
	});
}

/** The step's own words, with the whole request and the earlier results it may use as data. */
export function stepRequest(
	step: PlanStep,
	request: string,
	results: ReadonlyMap<string, string>,
): string {
	const earlier = step.inputs
		.flatMap((id) => {
			const r = results.get(id);
			return r ? [`[${id}] ${r}`] : [];
		})
		.join("\n");
	return [
		step.goal,
		`（依頼全体:「${request}」のうち、このステップだけを行ってください。）`,
		...(earlier ? [`前のステップの結果（確認済み）:\n${earlier}`] : []),
	].join("\n");
}

/** The summary step's prompt: the request and the verified results; nothing else. */
export function summaryPrompt(
	step: PlanStep,
	request: string,
	results: ReadonlyMap<string, string>,
): string {
	const earlier = step.inputs
		.flatMap((id) => {
			const r = results.get(id);
			return r ? [`[${id}] ${r}`] : [];
		})
		.join("\n");
	return [
		`依頼:「${request}」`,
		`このステップ: ${step.goal}`,
		"前のステップの結果（確認済み）。ここにない事実は書かないでください:",
		earlier || "(なし)",
	].join("\n");
}

export { budgetCheck, planBudget, planSteps };

/**
 * A session several trials share: `open` starts it once, a trial's `close` leaves it running, and only
 * `release` stops it.
 */
export function holdSession(inner: PlatformAdapter): {
	adapter: PlatformAdapter;
	release(): Promise<void>;
} {
	let opened: Promise<void> | null = null;
	const adapter = Object.create(inner) as PlatformAdapter;
	Object.assign(adapter, {
		open: (signal: AbortSignal) => {
			opened ??= inner.open(signal).catch((error: unknown) => {
				opened = null;
				throw error;
			});
			return opened;
		},
		close: async () => {},
	});
	for (const key of [
		"toolInfo",
		"catalog",
		"state",
		"listTargets",
		"selectTarget",
		"newTarget",
		"observe",
		"dispatch",
		"extract",
	] as const) {
		const f = (inner as unknown as Record<string, unknown>)[key];
		if (typeof f === "function")
			(adapter as unknown as Record<string, unknown>)[key] = f.bind(inner);
	}
	return { adapter, release: () => inner.close() };
}

/**
 * Waits until the user ends the kept session (`decide` returns true for a line) or `idleMs` pass with no line
 * at all; each line that does not end it restarts the wait. Resolves with why it ended.
 */
export async function holdUntil(
	lines: AsyncIterable<string>,
	decide: (line: string) => boolean,
	idleMs: number,
): Promise<"user_done" | "idle_timeout" | "input_closed"> {
	const it = lines[Symbol.asyncIterator]();
	for (;;) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const idle = new Promise<"idle">((resolve) => {
			timer = setTimeout(() => resolve("idle"), idleMs);
		});
		const next = await Promise.race([it.next(), idle]);
		clearTimeout(timer);
		if (next === "idle") return "idle_timeout";
		if (next.done) {
			// No more input (a non-interactive start): only the idle timeout ends it.
			await new Promise((r) => setTimeout(r, idleMs));
			return "input_closed";
		}
		if (decide(next.value)) return "user_done";
	}
}

export type ChainBudgetView = ReturnType<typeof budgetCheck>;
