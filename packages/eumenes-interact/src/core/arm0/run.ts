import type {
	AppliedStep,
	CoreState,
	HostOutcome,
	ParsedStep,
	ParseRecord,
	PreparedStep,
	ShapedObservation,
	StartRunInput,
	TabView,
} from "../../contracts/core.ts";
import type {
	ObservationEnvelope,
	RawObservation,
} from "../../contracts/observation.ts";
import { expireObservations } from "./fold.ts";
import { boundSnapshot, refsOf } from "./observation.ts";
import { observationView, refusal, tabLine, unretryable } from "./result.ts";
import { parseArm0State, type Arm0State, type Work } from "./state.ts";
import {
	recordOutput,
	recordToolResult,
	startTask,
	taskCallsLeft,
	taskControl,
	taskMessages,
	type TaskToolResult,
} from "./task.ts";
import { CORRECTION, PROFILE, REFERENCE_INTRO, RULES, SKILL } from "./texts.ts";
import { offeredTools, planCall, toolList } from "./tools.ts";
import { addSeen, clip, originOf, placeOf } from "./text.ts";

/**
 * Arm 0: Eumenes' browser page operator at commit `98b188d2` as a pure one-step core (plan.md §4, §10.3). The
 * composition of the first input follows `browser-task-runner.ts` `begin`, a step follows `advance`.
 */

const MAX_TABS = 20;
const MAX_EVIDENCE = 64;

function stateOf(state: CoreState): Arm0State {
	const parsed = parseArm0State(state);
	if (!parsed) throw new Error("core_state_invalid");
	return parsed;
}

/** The state of a run that can still take a step. */
function liveStateOf(state: CoreState): Arm0State {
	const current = stateOf(state);
	if (current.ended) throw new Error("core_run_ended");
	return current;
}

const tabKey = (o: ObservationEnvelope) =>
	o.target.kind === "tab" ? o.target.tabRef : o.target.windowRef;

/** What a page the task read leaves in its work: the origin, the text a typed value is compared with, the latest refs. */
function seeing(work: Work, o: ObservationEnvelope): Work {
	return {
		...work,
		origin: originOf(o.url),
		seen: addSeen(work.seen, `${o.title ?? ""}\n${o.body}`),
		evidence: work.evidence.includes(o.observationRef)
			? work.evidence
			: [...work.evidence, o.observationRef].slice(-MAX_EVIDENCE),
		latest: {
			...work.latest,
			[tabKey(o)]: { observationRef: o.observationRef, refs: refsOf(o.body) },
		},
	};
}

/** What the host may put into `StartRunInput.reference`; every other key is kept as the host wrote it. */
type Arm0Reference = {
	/** The current tab's first observation. */
	observation?: ObservationEnvelope | null;
	tabs?: readonly TabView[];
	/** Input values the user allowed (Eumenes `approvedView`), passed on to REFERENCE. */
	approved?: readonly { kind?: unknown }[];
	scriptRequired?: unknown;
	[key: string]: unknown;
};

/**
 * REFERENCE as the runner composes it: `observation` and `tabs` become the views of `target`, `tabs` and
 * `observation`; the keys the host gave before them (`requestedUrl`, `connection`…) keep their order.
 */
function referenceOf(reference: Arm0Reference) {
	const { observation, tabs, approved } = reference;
	const rest = { ...reference };
	for (const key of ["observation", "tabs", "approved", "scriptRequired"])
		delete rest[key];
	return {
		...rest,
		// No Script tool is offered, so a Script is never required.
		scriptRequired: false,
		target: observation
			? {
					tabRef: tabKey(observation),
					title: clip(observation.title ?? "", 100),
					place: placeOf(observation.url ?? ""),
				}
			: null,
		tabs: (tabs ?? []).slice(0, MAX_TABS).map(tabLine),
		observation: observation ? observationView(observation) : null,
		...(approved?.length ? { approved } : {}),
	};
}

export function startRun(input: StartRunInput): CoreState {
	if (input.arm !== "arm0") throw new Error("unknown_arm");
	const ids = offeredTools(input.tools);
	const reference: Arm0Reference = input.reference ?? {};
	const { observation, tabs, approved } = reference;
	const grants = !!approved?.some((item) => item.kind === "input_value");
	const task = startTask({
		control: taskControl({
			profile: PROFILE,
			skills: [SKILL],
			rules: RULES,
			tools: toolList(ids, grants),
		}),
		request: input.request,
		...(input.brief ? { brief: input.brief } : {}),
		reference: referenceOf(reference),
		referenceIntro: REFERENCE_INTRO,
		correction: CORRECTION,
		policy: { ...input.policy, retries: { ...input.policy.retries } },
		nowMs: input.nowMs,
	});
	const empty: Work = {
		tabRef: null,
		origin: null,
		tools: ids,
		grants,
		seen: addSeen([], ...(tabs ?? []).map((t) => t.title ?? "")),
		evidence: [],
		latest: {},
		pending: null,
	};
	// Parsing the state checks the policy against the bounds a stored state has.
	return stateOf({
		formatVersion: 1,
		arm: "arm0",
		task,
		ended: false,
		work: observation
			? { ...seeing(empty, observation), tabRef: tabKey(observation) }
			: empty,
	});
}

export function prepareStep(state: CoreState): PreparedStep {
	const { task } = liveStateOf(state);
	return { messages: taskMessages(task), callsLeft: taskCallsLeft(task) };
}

const ENDING = ["failed", "finish", "clarify", "stop", "stopped"];

export function parseStep(
	state: CoreState,
	raw: string,
): { state: CoreState; step: ParsedStep; record: ParseRecord } {
	const parsed = parseLive(liveStateOf(state), raw);
	return {
		...parsed,
		state: { ...parsed.state, ended: ENDING.includes(parsed.step.kind) },
	};
}

function parseLive(
	current: Arm0State,
	raw: string,
): { state: Arm0State; step: ParsedStep; record: ParseRecord } {
	const { state: task, step, record } = recordOutput(current.task, raw);
	const next = (patch: Partial<Arm0State>): Arm0State => ({
		...current,
		task,
		...patch,
	});
	switch (step.kind) {
		case "repair":
			return {
				state: next({}),
				step: { kind: "continue", callsLeft: step.callsLeft },
				record,
			};
		case "failed":
			return { state: next({}), step, record };
		case "clarify":
			return { state: next({}), step, record };
		case "finish":
			return {
				state: next({}),
				step: {
					kind: "finish",
					text: step.text,
					refs: step.refs.filter((ref) => current.work.evidence.includes(ref)),
				},
				record,
			};
		case "invoke": {
			const plan = planCall(
				step.tool,
				step.arguments,
				current.work,
				task.messages[2]!.content,
			);
			if (plan.kind === "call")
				return {
					state: next({
						work: {
							...current.work,
							pending: {
								tool: step.tool,
								...(plan.tabRef ? { tabRef: plan.tabRef } : {}),
							},
						},
					}),
					step: {
						kind: "call",
						tool: step.tool,
						call: plan.call,
						callsLeft: step.callsLeft,
					},
					record,
				};
			if (plan.kind === "ask")
				return {
					state: next({}),
					step: {
						kind: "stop",
						code: "input_value_unconfirmed",
						text: plan.text,
						approvals: [plan.approval],
					},
					record,
				};
			// A refusal of the run's own checks goes to the model as the tool's result and counts against its retries.
			const recorded = recordToolResult(task, step.tool, plan.result);
			return {
				state: next({ task: recorded.state }),
				step:
					recorded.step.kind === "failed"
						? recorded.step
						: { kind: "continue", callsLeft: recorded.step.callsLeft },
				record: plan.record,
			};
		}
	}
}

/** The result the model reads and the work it leaves behind, for what the host learned. */
function outcomeResult(
	work: Work,
	tool: string,
	pendingTab: string | undefined,
	outcome: Exclude<HostOutcome, { kind: "stop" }>,
): { work: Work; result: TaskToolResult; observed: boolean } {
	switch (outcome.kind) {
		case "observation":
			return {
				work: seeing(work, outcome.observation),
				result: { ok: true, observation: observationView(outcome.observation) },
				observed: true,
			};
		case "tabs":
			return {
				work: {
					...work,
					seen: addSeen(work.seen, ...outcome.tabs.map((t) => t.title ?? "")),
				},
				result: {
					ok: true,
					current: work.tabRef,
					tabs: outcome.tabs.slice(0, MAX_TABS).map(tabLine),
				},
				observed: false,
			};
		case "refused":
			return {
				work,
				result:
					outcome.retryable === false
						? unretryable(outcome.code)
						: refusal(outcome.code, outcome.detail),
				observed: false,
			};
		case "operation": {
			const { result, observation } = outcome;
			if (result.status === "indeterminate")
				return {
					work,
					result: unretryable(result.code ?? "operation_indeterminate"),
					observed: false,
				};
			if (result.status !== "confirmed")
				return {
					work,
					result: refusal(result.code ?? "operation_failed"),
					observed: false,
				};
			// An action that reached the page voids the tab's observations; selecting a tab does not touch the page.
			const acts =
				tool !== "browser.page.tab_select" && tool !== "browser.page.tab_new";
			const latest = { ...work.latest };
			if (acts && work.tabRef) delete latest[work.tabRef];
			// A new tab becomes the browser's current one. Without its observation the run does not know it, so
			// the old tab must not be acted on: no tab is targeted until the model selects one (`no_target_tab`).
			let next: Work = {
				...work,
				latest,
				tabRef:
					tool === "browser.page.tab_select"
						? (pendingTab ?? work.tabRef)
						: tool === "browser.page.tab_new"
							? observation
								? tabKey(observation)
								: null
							: work.tabRef,
				origin: result.url ? originOf(result.url) : work.origin,
			};
			if (observation) next = seeing(next, observation);
			return {
				work: next,
				result: {
					ok: true,
					state: "done",
					...(observation ? { observation: observationView(observation) } : {}),
				},
				observed: !!observation,
			};
		}
	}
}

export function applyResult(
	state: CoreState,
	outcome: HostOutcome,
): { state: CoreState; step: AppliedStep } {
	const current = liveStateOf(state);
	const pending = current.work.pending;
	if (!pending) throw new Error("core_state_invalid");
	if (outcome.kind === "stop")
		return {
			state: {
				...current,
				ended: true,
				work: { ...current.work, pending: null },
			},
			step: { kind: "stopped", code: outcome.code, text: outcome.text },
		};
	const { work, result, observed } = outcomeResult(
		current.work,
		pending.tool,
		pending.tabRef,
		outcome,
	);
	// Refs of the pages read so far are void once a newer observation arrives.
	const recorded = recordToolResult(
		observed ? expireObservations(current.task) : current.task,
		pending.tool,
		result,
	);
	const next: Arm0State = {
		...current,
		task: recorded.state,
		ended: recorded.step.kind === "failed",
		work: { ...work, pending: null },
	};
	return {
		state: next,
		step:
			recorded.step.kind === "failed"
				? recorded.step
				: { kind: "continue", callsLeft: recorded.step.callsLeft },
	};
}

/** The bounded body of a snapshot, as Arm 0 shows it; the adapter's own cut (`raw.truncated`) is the host's to report. */
export function shapeObservation(
	arm: "arm0",
	raw: RawObservation,
): ShapedObservation {
	if (arm !== "arm0") throw new Error("unknown_arm");
	const bounded = boundSnapshot(raw.body);
	return {
		body: bounded.text,
		truncated: bounded.truncated,
		truncationReasons: bounded.reasons,
		refCount: bounded.refs.length,
		refs: bounded.refs,
	};
}

export const parseCoreState = (value: unknown): CoreState | null =>
	parseArm0State(value);
