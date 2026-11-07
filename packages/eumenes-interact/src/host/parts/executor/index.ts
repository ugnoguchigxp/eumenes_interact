import type {
	ObservationEnvelope,
	PageSummary,
	PartCall,
	PartResult,
	TabView,
} from "../../../index.ts";
import type { Executed } from "../ports.ts";
import {
	createContext,
	Halt,
	noteObservation,
	PartFail,
	tabOf,
	summarize,
	type Body,
	type PartExecutorDeps,
} from "./context.ts";
import { itemOpen } from "./item.ts";
import {
	pageBack,
	pageFind,
	pageList,
	pageOpen,
	pageRead,
	pageWait,
} from "./page.ts";
import { siteSearch } from "./search.ts";
import { formFill, formInspect, formSubmit } from "./form.ts";
import { pageCapture } from "./capture.ts";

export {
	SUMMARY_HEADINGS,
	SUMMARY_ITEMS,
	type PartExecutorDeps,
} from "./context.ts";
export { effectOf } from "./item.ts";
export { surrounding } from "./page.ts";
export {
	sortApplied,
	sortCarried,
	sortOptionsOf,
	sortUrl,
	withSortControls,
} from "./sort.ts";

/**
 * The part executor of Arm 1 (plan.md §6.4): one implementation per registered part, each a deterministic
 * sequence of operations run through the host's executor. Every inner operation therefore keeps the URL policy,
 * the approval gate, the ledger (`dispatched` committed before the adapter is awaited), the stale checks and
 * the rule that an indeterminate operation is never sent again. The model sees page summaries and host-issued
 * item ids; refs never leave this module, and an id that cannot be matched to exactly one element in a fresh
 * observation is a candidate list for the model, never a guess.
 */

export function createPartExecutor(deps: PartExecutorDeps) {
	const ctx = createContext(deps);

	async function dispatch(call: PartCall): Promise<Body> {
		if (
			ctx.blocked &&
			["item.open", "form.fill", "form.submit"].includes(call.part)
		)
			throw new PartFail("site_blocked");
		switch (call.part) {
			case "page.open":
				return pageOpen(ctx, call.args.url);
			case "page.back":
				return pageBack(ctx);
			case "site.search":
				return siteSearch(ctx, call.args.query, call.args.field);
			case "page.find":
				return pageFind(
					ctx,
					call.args.text,
					call.args.role,
					call.args.within,
					call.args.cursor,
					call.args.inspect,
				);
			case "item.open":
				return itemOpen(ctx, call.args.item);
			case "page.wait":
				if (call.args.condition != null)
					ctx.blocked = call.args.condition === "blocked";
				return pageWait(ctx, call.args.text, call.args.seconds);
			case "page.read":
				return pageRead(ctx, call.args.target, call.args.maxChars);
			case "page.list":
				return pageList(
					ctx,
					call.args.kind,
					call.args.limit,
					call.args.within,
					call.args.cursor,
				);
			case "page.capture":
				return pageCapture(
					ctx,
					call.args.range,
					call.args.item,
					call.args.phase,
					call.args.confirmation,
					call.args.assessment,
					call.args.offset,
				);
			case "form.inspect":
				return formInspect(ctx, call.args.form);
			case "form.fill":
				return formFill(ctx, call.args.fields);
			case "form.submit":
				return formSubmit(ctx, call.args.button);
			case "done":
			case "ask":
				// The core turns these into the end of the run; they never reach the host.
				throw new PartFail("not_executable");
		}
	}

	const finish = (part: PartCall["part"], body: Body): PartResult => ({
		part,
		resultId: `r${++ctx.results}`,
		...body,
	});

	/**
	 * Runs one part. The result is what the model is shown; a stop for approval and the end of the run come back
	 * as the run loop's own outcomes. The transcript gets the part's name and argument names, and its status.
	 */
	async function run(call: PartCall): Promise<Executed> {
		ctx.recorder.partCall(call.part, Object.keys(call.args));
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
		ctx.recorder.partResult(call.part, status, code);
		ctx.deps.events.event("part.executed", { code: code ?? status });
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
		ctx.active = tabOf(first.observation) || null;
		noteObservation(ctx, first.observation);
		return summarize(ctx, first.observation);
	}

	return { run, begin };
}
