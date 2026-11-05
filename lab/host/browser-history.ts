import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserHistoryEntry } from "eumenes-collaboration";

/**
 * Browser-or-not choices later found wrong, kept between runs (a small JSON file under the gitignored
 * `lab/data/`). Fed back as `PlanOptions.history`, so the next alike step's inference sees its past mistake.
 */
export const DEFAULT_BROWSER_HISTORY = fileURLToPath(
	new URL("../data/browser-history.json", import.meta.url),
);

/** The newest entries kept; older ones are dropped. */
export const BROWSER_HISTORY_MAX = 50;

const GOAL_MAX = 200;

/** A missing, broken or foreign file reads as no history: history only advises. */
export function loadBrowserHistory(path: string): BrowserHistoryEntry[] {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(e): e is BrowserHistoryEntry =>
				typeof e === "object" &&
				e !== null &&
				typeof e.goal === "string" &&
				typeof e.browser === "boolean" &&
				typeof e.correct === "boolean",
		)
		.map((e) => ({ goal: e.goal, browser: e.browser, correct: e.correct }))
		.slice(-BROWSER_HISTORY_MAX);
}

/** Adds one misjudgment (the same goal and choice replaces its older entry), keeping the newest `max`. */
export function recordMisjudgment(
	path: string,
	entry: { goal: string; browser: boolean },
	max = BROWSER_HISTORY_MAX,
): BrowserHistoryEntry[] {
	const goal = entry.goal.slice(0, GOAL_MAX);
	const next = [
		...loadBrowserHistory(path).filter(
			(e) => !(e.goal === goal && e.browser === entry.browser),
		),
		{ goal, browser: entry.browser, correct: !entry.browser },
	].slice(-max);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`);
	renameSync(tmp, path);
	return next;
}
