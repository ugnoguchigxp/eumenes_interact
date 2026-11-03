/**
 * Writes the golden files `test/core/arm0-golden.test.ts` compares the Arm 0 core with (plan.md §4: the same
 * SystemContext and fold results for the same input). The golden is what Eumenes' own pure modules produce, read
 * at commit 98b188d2 by path from a read-only Eumenes checkout:
 *
 *   bun lab/arm0-golden/generate.ts
 *
 * Nothing is written inside Eumenes. Every Eumenes file the script loads is read from the commit (`git show`),
 * not from the working tree, which other people edit; it warns when a loaded file differs from the commit.
 * Eumenes' file-writing logger, the LARM domain and the domain barrels of
 * inference and browser are replaced while loading (see `stubs/` and the resolver below): the functions the
 * generator calls use none of them.
 *
 * The generator also replays, in `runTool` and `fakeApi`, the parts of Eumenes' runner and browser domain that
 * need its database (`browser-task-runner.ts`, `assertActionable`, `grants.ts`); each is marked where it
 * copies Eumenes.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COMMIT = "98b188d2c61352d2278b1912a78e8cd465d37671";
const EUMENES = process.env.EUMENES_DIR ?? "/Users/y.noguchi/Code/eumenes";
const HERE = import.meta.dir;
const INPUTS = join(HERE, "inputs");
const GOLDEN = join(HERE, "golden");

/** Every Eumenes file the generator loads or reads, relative to the checkout. */
const SOURCES = [
	".s11tnext/catalog.generated.ts",
	".s11tnext/catalog.json",
	"api/application/browser/browser-fold.ts",
	"api/application/browser/browser-task-tools.ts",
	"api/application/browser/browser-text.ts",
	"api/domains/browser/contracts/history.ts",
	"api/domains/browser/contracts/index.ts",
	"api/domains/browser/contracts/replay.ts",
	"api/domains/browser/contracts/script.ts",
	"api/domains/browser/service/observation.ts",
	"api/domains/capabilities/bundles/browser.bundle.json",
	"api/domains/capabilities/contracts/browser.ts",
	"api/domains/capabilities/contracts/inputs.ts",
	"api/domains/inference/contracts/agent-core.ts",
	"api/domains/inference/contracts/agent-task.ts",
	"api/domains/inference/contracts/context-budget.ts",
	"api/domains/inference/contracts/context-render.ts",
	"api/domains/inference/contracts/index.ts",
	"api/domains/inference/contracts/record-pages.ts",
	"api/domains/inference/contracts/screen-presence.ts",
	"api/infrastructure/context-budget.ts",
	"api/infrastructure/jst-time.ts",
	"api/infrastructure/llm-json.ts",
	"api/infrastructure/reference-json.ts",
	"api/infrastructure/system-context.ts",
];

function git(...args: string[]) {
	return spawnSync("git", ["-C", EUMENES, ...args], { encoding: "utf8" });
}
for (const file of SOURCES) {
	const inCommit = git("cat-file", "-e", `${COMMIT}:${file}`);
	if (inCommit.status !== 0)
		throw new Error(`${file} is not in Eumenes commit ${COMMIT}`);
}
// Files with uncommitted edits are not trusted: every Eumenes file loaded below is served from the commit
// itself (the resolver's `onLoad`), so the golden is the commit's behaviour whatever the working tree holds.
const changed = git("diff", "--name-only", COMMIT, "--", ...SOURCES)
	.stdout.split("\n")
	.filter(Boolean);
if (changed.length)
	console.warn(
		`working tree differs from ${COMMIT.slice(0, 8)} in ${changed.join(", ")}; reading them from the commit`,
	);
const show = (file: string) => {
	const shown = spawnSync("git", ["-C", EUMENES, "show", `${COMMIT}:${file}`], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (shown.status !== 0) throw new Error(`git show ${COMMIT}:${file} failed`);
	return shown.stdout;
};

const STUBS = join(HERE, "stubs");
Bun.plugin({
	name: "eumenes-pure",
	setup(build) {
		// Eumenes' own sources and data, not its dependencies.
		const own = new RegExp(
			`^${EUMENES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?!node_modules/).*\\.(ts|json)$`,
		);
		build.onLoad({ filter: own }, (args) => {
			const file = args.path.slice(EUMENES.length + 1);
			return file.endsWith(".json")
				? { exports: { default: JSON.parse(show(file)) }, loader: "object" }
				: { contents: show(file), loader: "ts" };
		});
		const redirect = (filter: RegExp, importer: RegExp, path: string) =>
			build.onResolve({ filter }, (args) =>
				importer.test(args.importer) ? { path } : undefined,
			);
		redirect(
			/^\.\/logger$/,
			/infrastructure\/llm-json\.ts$/,
			`${STUBS}/logger.ts`,
		);
		redirect(
			/^\.\.\/\.\.\/larm$/,
			/inference\/contracts\/index\.ts$/,
			`${STUBS}/larm.ts`,
		);
		// browser-fold only needs `rewriteReferences`; browser-task-tools only `BrowserApprovalRequired`.
		redirect(
			/^\.\.\/\.\.\/domains\/inference$/,
			/browser-fold\.ts$/,
			`${EUMENES}/api/domains/inference/contracts/agent-task.ts`,
		);
		redirect(
			/^\.\.\/\.\.\/domains\/browser$/,
			/browser-task-tools\.ts$/,
			`${EUMENES}/api/domains/browser/contracts/index.ts`,
		);
	},
});

const load = (path: string): Promise<any> => import(`${EUMENES}/${path}`);
const { z } = await load("node_modules/zod");
const task = await load("api/domains/inference/contracts/agent-task.ts");
const core = await load("api/domains/inference/contracts/agent-core.ts");
const fold = await load("api/application/browser/browser-fold.ts");
const text = await load("api/application/browser/browser-text.ts");
const toolsModule = await load("api/application/browser/browser-task-tools.ts");
const { boundSnapshot } = await load(
	"api/domains/browser/service/observation.ts",
);
const { systemContext } = await load("api/infrastructure/system-context.ts");
const browserSchemas = await load(
	"api/domains/capabilities/contracts/browser.ts",
);
const inputSchemas = await load("api/domains/capabilities/contracts/inputs.ts");

const {
	PAGE_TOOLS,
	FATAL_CODES,
	argumentHints,
	observationView,
	approvedView,
	refusal,
} = toolsModule;
const { addSeen, clip, originOf, placeOf, squash } = text;

// ---------------------------------------------------------------------------------------------------------
// Texts: the profile and Skill of the effective package revision, and the three rendered SystemContexts.

const bundle = JSON.parse(
	show("api/domains/capabilities/bundles/browser.bundle.json"),
);
const definition = (kind: string, id: string, revision: number) => {
	const found = bundle.definitions.find(
		(d: any) => d.kind === kind && d.id === id && d.revision === revision,
	);
	if (!found) throw new Error(`${kind}:${id}@${revision} is not in the bundle`);
	return found;
};
const operatorPackage = definition("package", "browser.page-operator", 5);
const revisionOf = (dependency: string) => {
	const [, id, revision] = /^\w+:(.+)@(\d+)$/.exec(dependency)!;
	return { id: id!, revision: Number(revision) };
};
const profile = definition(
	"profile",
	...(Object.values(revisionOf(operatorPackage.profileRevisionId)) as [
		string,
		number,
	]),
).body.trim();
const skills = operatorPackage.requiredSkillRevisionIds.map(
	(dependency: string) => {
		const { id, revision } = revisionOf(dependency);
		return definition("skill", id, revision).body.trim();
	},
);
const RULES = systemContext("browser.contexts.page-operator.rules", {});
const REFERENCE_INTRO = systemContext(
	"browser.contexts.page-operator.reference",
	{},
);
const CORRECTION = systemContext(
	"browser.contexts.page-operator.correction",
	{},
);

/** The tools of the ported subset, in the package's order, with the schema key each is registered with. */
const PORTED = [
	"tabs",
	"tab_select",
	"tab_new",
	"navigate",
	"back",
	"observe",
	"click",
	"hover",
	"type",
	"select",
	"press",
	"wait",
].map((name) => `browser.page.${name}`);
const SCHEMAS: Record<string, unknown> = {
	emptyInput: inputSchemas.emptyInput,
	browserTabTarget: browserSchemas.browserTabTarget,
	browserTabOpen: browserSchemas.browserTabOpen,
	browserPageClick: browserSchemas.browserPageClick,
	browserPageHover: browserSchemas.browserPageHover,
	browserPageType2: browserSchemas.browserPageType2,
	browserPageTypeValue2: browserSchemas.browserPageTypeValue2,
	browserPageSelect: browserSchemas.browserPageSelect,
	browserPagePress: browserSchemas.browserPagePress,
	browserPageWait: browserSchemas.browserPageWait,
};
const toolDefinitions = PORTED.map((id) => {
	const dependency = operatorPackage.toolRevisionIds.find(
		(d: string) => revisionOf(d).id === id,
	);
	if (!dependency) throw new Error(`${id} is not in the package`);
	const { revision } = revisionOf(dependency);
	const tool = definition("tool", id, revision);
	if (PAGE_TOOLS[id].schemaKey !== tool.schemaKey)
		throw new Error(`${id}: the host and the package disagree on the schema`);
	return {
		id,
		revision,
		summary: tool.summary as string,
		schemaKey: tool.schemaKey as string,
	};
});

/** `operatorOf` + `begin` of the runner: TOOLS for the offered ids; `type` shows only the request quotation unless an input value was approved. */
function toolsFor(ids: readonly string[], hasApprovedInput: boolean) {
	return toolDefinitions
		.filter((t) => ids.includes(t.id))
		.map((t) => ({
			id: t.id,
			description: t.summary,
			inputSchema: z.toJSONSchema(
				SCHEMAS[
					!hasApprovedInput && t.id === "browser.page.type"
						? "browserPageType2"
						: t.schemaKey
				],
			),
		}));
}

// ---------------------------------------------------------------------------------------------------------
// Observations

const snapshotText = (name: string) =>
	readFileSync(join(INPUTS, `${name}.aria.txt`), "utf8");
let generation = 0;

type ObservationInput = {
	observationRef: string;
	tabRef: string;
	snapshot: string;
	url: string;
	title: string;
};
/** One snapshot as Eumenes' `observe` stores it (bounded) and as the host would wrap it for the core. */
function observe(input: ObservationInput) {
	const bounded = boundSnapshot(snapshotText(input.snapshot));
	generation += 1;
	return {
		eumenes: {
			observationRef: input.observationRef,
			tabRef: input.tabRef,
			generation,
			url: input.url,
			title: input.title,
			text: bounded.text,
			truncated: bounded.truncated,
			reasons: bounded.reasons,
			refCount: bounded.refs.length,
		},
		envelope: {
			observationRef: input.observationRef,
			platform: "playwright-mcp",
			sessionId: "arm0-golden",
			target: { kind: "tab", tabRef: input.tabRef },
			generation,
			capturedAt: "2026-11-03T05:00:00.000Z",
			url: input.url,
			title: input.title,
			body: bounded.text,
			truncated: bounded.truncated,
			truncationReasons: bounded.reasons,
			refCount: bounded.refs.length,
			missing: [],
		},
		refs: bounded.refs as string[],
	};
}

// ---------------------------------------------------------------------------------------------------------
// Scenarios

type TabInput = {
	tabRef: string;
	title: string;
	url: string;
	current: boolean;
};
type HostInput =
	| { kind: "observation"; observation: ObservationInput }
	| {
			kind: "operation";
			status: "confirmed" | "failed" | "indeterminate";
			code?: string;
			url?: string;
			observation?: ObservationInput;
	  }
	| { kind: "tabs"; tabs: TabInput[] };
type Scenario = {
	name: string;
	start: {
		request: string;
		brief?: string;
		nowMs: number;
		policy: { maxModelCalls: number; retries: Record<string, number> };
		tools?: string[];
		tabs: TabInput[];
		observation?: ObservationInput;
		requestedUrl?: string;
		connection?: unknown;
		approved?: Record<string, unknown>[];
	};
	steps: { label: string; output: string; host?: HostInput }[];
};

/** The tab list of Eumenes' `TabView` for what the host hands the core. */
const eumenesTab = (t: TabInput) => ({
	tabRef: t.tabRef,
	title: t.title,
	url: t.url,
	active: t.current,
	status: "idle",
});

/** What the host answers, as Eumenes' browser domain would answer it (the fake api below). */
function fakeApi(
	request: string,
	latest: Map<string, { ref: string; refs: string[] }>,
	answer: () => HostInput | undefined,
	reached: () => void,
) {
	const used = (kind: HostInput["kind"]) => {
		const host = answer();
		if (!host || host.kind !== kind)
			throw new Error(`the scenario step needs a host answer of kind ${kind}`);
		reached();
		return host;
	};
	const seen = (input: ObservationInput | undefined, tabRef: string) => {
		if (!input) throw new Error("the host answer has no observation");
		const o = observe(input);
		if (input.tabRef !== tabRef)
			throw new Error(`observation of ${input.tabRef} given for ${tabRef}`);
		latest.set(tabRef, { ref: o.eumenes.observationRef, refs: o.refs });
		return o.eumenes;
	};
	return {
		tabs: async () => (used("tabs") as any).tabs.map(eumenesTab),
		observe: async (tabRef: string) => {
			const host = answer();
			if (!host || host.kind === "tabs")
				throw new Error("the scenario step needs an observation");
			reached();
			return seen(host.observation, tabRef);
		},
		operate: async (tabRef: string | undefined, action: any) => {
			// `assertActionable` (api/domains/browser/service/tabs.ts, commit 98b188d2).
			if (["click", "hover", "type", "select"].includes(action.kind)) {
				const current = latest.get(tabRef!);
				if (!current || current.ref !== action.observationRef)
					throw new Error("observation_stale");
				if (!current.refs.includes(action.ref))
					throw new Error("ref_not_actionable");
			}
			const host = used("operation") as Extract<
				HostInput,
				{ kind: "operation" }
			>;
			// `bumpGeneration`: an action that may have reached the page voids the observations of its tab.
			if (tabRef && action.kind !== "tab_select" && host.status !== "failed")
				latest.delete(tabRef);
			return {
				operationId: "op",
				state: host.status === "confirmed" ? "observed" : host.status,
				...(action.kind === "tab_new" && host.observation
					? { tabRef: host.observation.tabRef }
					: {}),
				...(host.url ? { url: host.url } : {}),
				...(host.code ? { errorCode: host.code } : {}),
			};
		},
		// `fromRequestInTransaction` (api/domains/browser/service/grants.ts, commit 98b188d2).
		grantFromRequest: async (input: any) => {
			const quote = squash(input.quote);
			if (
				quote.length < 2 ||
				input.value.length > 4 * quote.length + 32 ||
				!squash(request).includes(quote)
			)
				throw new Error("grant_source_mismatch");
			return { inputValueRef: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
		},
		variableValue: () => {
			throw new Error("script_variable_unknown");
		},
		grantFromHistoryVariable: async () => null,
	};
}

/** `runTool` of the runner (api/application/browser/browser-task-runner.ts, commit 98b188d2). */
async function runTool(tool: string, args: Record<string, unknown>, env: any) {
	const host = env.work.tools.includes(tool) ? PAGE_TOOLS[tool] : undefined;
	if (!host) return { kind: "result", result: refusal("unknown_tool") };
	const schema = SCHEMAS[host.schemaKey] as any;
	const parsed = schema.safeParse(args);
	if (!parsed.success) {
		const detail = argumentHints(parsed.error.issues);
		const paired =
			host.schemaKey === "browserPageTypeValue2" &&
			!Object.hasOwn(args, "inputValueRef")
				? (SCHEMAS.browserPageType2 as any).safeParse(args)
				: null;
		const issues =
			paired && !paired.success ? paired.error.issues : parsed.error.issues;
		return {
			kind: "result",
			result: refusal("invalid_arguments", {
				...(detail ? { detail } : {}),
				issues: issues.slice(0, 8).map((issue: any) => ({
					path: issue.path.map(String).join("."),
					code: issue.code,
				})),
			}),
		};
	}
	try {
		return await host.run(parsed.data, env);
	} catch (e) {
		const code =
			e instanceof Error && /^[a-z][a-z0-9_]*$/.test(e.message)
				? e.message
				: "operation_failed";
		if (FATAL_CODES.has(code)) throw e;
		return { kind: "result", result: refusal(code) };
	}
}

const taskSnapshot = (state: any) => ({
	callsMade: state.callsMade,
	repaired: state.repaired,
	refusals: state.refusals,
	pendingRaw: state.pendingRaw,
	// The system message never changes after the start, which is compared on its own.
	messages: state.messages.slice(1),
});

async function runScenario(scenario: Scenario) {
	const spec = scenario.start;
	const toolIds = spec.tools ?? PORTED;
	const hasApprovedInput = !!spec.approved?.some(
		(i) => i.kind === "input_value",
	);
	const observed = spec.observation ? observe(spec.observation) : null;
	const tabs = spec.tabs.map(eumenesTab);
	const approved = spec.approved ?? [];
	const approvedViews = approvedView(
		approved.map((item) => ({ ...item, approvalId: "approval" })),
	);
	// `begin` of the runner.
	const work = {
		tabRef: observed ? observed.eumenes.tabRef : null,
		origin: observed ? originOf(observed.eumenes.url) : null,
		tools: toolIds,
		seen: addSeen(
			[],
			...tabs.map((t: any) => t.title),
			observed ? `${observed.eumenes.title}\n${observed.eumenes.text}` : "",
		),
		evidence: observed ? [observed.eumenes.observationRef] : [],
		captures: [],
	};
	let state = task.startTask({
		control: task.taskControl({
			profile,
			skills,
			rules: RULES,
			tools: toolsFor(toolIds, hasApprovedInput),
		}),
		request: spec.request,
		...(spec.brief ? { brief: spec.brief } : {}),
		reference: {
			...(spec.requestedUrl ? { requestedUrl: spec.requestedUrl } : {}),
			...(spec.connection ? { connection: spec.connection } : {}),
			scriptRequired: false,
			target: observed
				? {
						tabRef: observed.eumenes.tabRef,
						title: clip(observed.eumenes.title, 100),
						place: placeOf(observed.eumenes.url),
					}
				: null,
			tabs: tabs.slice(0, 20).map((t: any) => ({
				tabRef: t.tabRef,
				title: clip(t.title, 100),
				place: placeOf(t.url),
				active: t.active,
				status: t.status,
			})),
			observation: observed ? observationView(observed.eumenes) : null,
			...(approvedViews.length ? { approved: approvedViews } : {}),
		},
		referenceIntro: REFERENCE_INTRO,
		correction: CORRECTION,
		policy: {
			maxModelCalls: spec.policy.maxModelCalls,
			retries: { ...spec.policy.retries },
		},
		nowMs: spec.nowMs,
	});
	const input = {
		arm: "arm0",
		request: spec.request,
		...(spec.brief ? { brief: spec.brief } : {}),
		reference: {
			...(spec.requestedUrl ? { requestedUrl: spec.requestedUrl } : {}),
			...(spec.connection ? { connection: spec.connection } : {}),
			tabs: spec.tabs,
			...(observed ? { observation: observed.envelope } : {}),
			...(approvedViews.length ? { approved: approvedViews } : {}),
		},
		policy: spec.policy,
		nowMs: spec.nowMs,
		...(spec.tools ? { tools: spec.tools } : {}),
	};
	const start = {
		input,
		systemMessage: state.messages[0].content,
		messages: state.messages.slice(1),
	};

	const latest = new Map<string, { ref: string; refs: string[] }>();
	if (observed)
		latest.set(observed.eumenes.tabRef, {
			ref: observed.eumenes.observationRef,
			refs: observed.refs,
		});
	let answer: HostInput | undefined;
	let reachedHost = false;
	const api = fakeApi(
		spec.request,
		latest,
		() => answer,
		() => {
			reachedHost = true;
		},
	);
	const env = {
		api,
		work,
		signal: new AbortController().signal,
		request: spec.request,
	};

	const steps = [];
	let ended = false;
	for (const step of scenario.steps) {
		if (ended)
			throw new Error(
				`${scenario.name}: "${step.label}" follows the end of the run`,
			);
		answer = step.host;
		reachedHost = false;
		const recorded = task.recordOutput(state, step.output);
		state = recorded.state;
		const s = recorded.step;
		const base = {
			label: step.label,
			output: step.output,
			...(step.host ? { host: hostOutcome(step.host) } : {}),
		};
		if (s.kind === "repair") {
			steps.push({
				...base,
				expected: {
					step: "continue",
					callsLeft: s.callsLeft,
					task: taskSnapshot(state),
				},
			});
		} else if (s.kind === "failed") {
			ended = true;
			steps.push({ ...base, expected: { step: "failed", code: s.code } });
		} else if (s.kind === "clarify") {
			ended = true;
			steps.push({ ...base, expected: { step: "clarify", text: s.text } });
		} else if (s.kind === "finish") {
			ended = true;
			steps.push({
				...base,
				expected: {
					step: "finish",
					text: s.text,
					refs: s.refs.filter((ref: string) => work.evidence.includes(ref)),
				},
			});
		} else {
			const out = await runTool(s.tool, s.arguments, env);
			if (out.kind === "stop") {
				ended = true;
				if (reachedHost || step.host)
					throw new Error(
						`${scenario.name}: "${step.label}" stops but has a host answer`,
					);
				steps.push({
					...base,
					expected: {
						step: "stop",
						code: out.code,
						text: out.text,
						approvals: out.approvals,
					},
				});
				continue;
			}
			if (step.host && !reachedHost)
				throw new Error(
					`${scenario.name}: "${step.label}" has a host answer that was not used`,
				);
			const result = out.result;
			const recordedResult = task.recordToolResult(
				result.ok && "observation" in result
					? fold.expireObservations(state)
					: state,
				s.tool,
				result,
			);
			state = recordedResult.state;
			const failed = recordedResult.step.kind === "failed";
			if (failed) ended = true;
			steps.push({
				...base,
				expected: {
					via: reachedHost ? "host" : "local",
					tool: s.tool,
					result,
					...(failed
						? { step: "failed", code: recordedResult.step.code }
						: {
								step: "continue",
								callsLeft: recordedResult.step.callsLeft,
								task: taskSnapshot(state),
							}),
				},
			});
		}
	}
	return { name: scenario.name, start, steps };
}

/** The host's answer as the core receives it. */
function hostOutcome(host: HostInput) {
	if (host.kind === "tabs") return host;
	if (host.kind === "observation")
		return {
			kind: "observation",
			observation: observe(host.observation).envelope,
		};
	return {
		kind: "operation",
		result: {
			operationId: "op",
			status: host.status,
			...(host.code ? { code: host.code } : {}),
			retryable: host.status === "failed",
			...(host.url ? { url: host.url } : {}),
		},
		...(host.observation
			? { observation: observe(host.observation).envelope }
			: {}),
	};
}

// ---------------------------------------------------------------------------------------------------------
// Write the golden files

const meta = {
	commit: COMMIT,
	zod: JSON.parse(
		readFileSync(`${EUMENES}/node_modules/zod/package.json`, "utf8"),
	).version,
	s11tnext: JSON.parse(
		readFileSync(`${EUMENES}/node_modules/s11tnext/package.json`, "utf8"),
	).version,
	jsonrepair: JSON.parse(
		readFileSync(`${EUMENES}/node_modules/jsonrepair/package.json`, "utf8"),
	).version,
};
mkdirSync(GOLDEN, { recursive: true });
const write = (name: string, value: unknown) =>
	writeFileSync(
		join(GOLDEN, name),
		`${JSON.stringify({ meta, ...(value as object) }, null, "\t")}\n`,
	);

write("texts.json", {
	profile,
	skills,
	rules: RULES,
	referenceIntro: REFERENCE_INTRO,
	correction: CORRECTION,
	tools: toolDefinitions,
});

const control = (ids: string[], hasApprovedInput: boolean) =>
	core.agentSystemMessage(
		task.taskControl({
			profile,
			skills,
			rules: RULES,
			tools: toolsFor(ids, hasApprovedInput),
		}),
	).content as string;
write("system.json", {
	cases: [
		{
			name: "ported-tools",
			tools: PORTED,
			approvedInput: false,
			system: control(PORTED, false),
		},
		{
			name: "tool-subset",
			tools: [
				"browser.page.observe",
				"browser.page.click",
				"browser.page.type",
				"browser.page.tabs",
			],
			approvedInput: false,
			system: control(
				[
					"browser.page.observe",
					"browser.page.click",
					"browser.page.type",
					"browser.page.tabs",
				],
				false,
			),
		},
		{
			name: "approved-input",
			tools: PORTED,
			approvedInput: true,
			system: control(PORTED, true),
		},
	],
});

const snapshots = ["small", "large", "refs", "deep", "mixed"];
const limits = { bytes: 200, depth: 3, refs: 5 };
write("bound.json", {
	cases: [
		...snapshots.map((name) => {
			const body = snapshotText(name);
			return { name, body, bounded: boundSnapshot(body) };
		}),
		...snapshots.map((name) => {
			const body = snapshotText(name);
			return {
				name: `${name}-limits`,
				body,
				limits,
				bounded: boundSnapshot(body, limits),
			};
		}),
	],
});

const scenarios: Scenario[] = JSON.parse(
	readFileSync(join(INPUTS, "scenarios.json"), "utf8"),
);
const results = [];
for (const scenario of scenarios) results.push(await runScenario(scenario));
write("scenarios.json", { scenarios: results });
console.log(
	`wrote ${["texts", "system", "bound", "scenarios"].join(", ")} to ${GOLDEN} (${results.length} scenarios, ${results.reduce((n, s) => n + s.steps.length, 0)} steps)`,
);
