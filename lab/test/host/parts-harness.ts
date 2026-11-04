import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PartCall, PartResult } from "eumenes-interact";
import {
	createRun,
	listOperations,
	transitionRun,
} from "eumenes-interact/sqlite";
import { FixtureApprover, type Approver } from "../../host/approval.ts";
import { RunControl } from "../../host/control.ts";
import { write } from "../../host/db.ts";
import { createExecutor, type Executed } from "../../host/executor.ts";
import { InputGrants } from "../../host/grants.ts";
import { silentLabLogger } from "../../host/log.ts";
import { CaptureStore } from "../../host/parts/capture.ts";
import type { PartsHelpers } from "../../host/parts/core.ts";
import { labEventsPort, labKnowledgePort } from "../../host/parts/ports.ts";
import { createPartExecutor } from "../../host/parts/executor.ts";
import { fixturePolicy, type UrlPolicy } from "../../host/policy.ts";
import { LAB_OWNER } from "../../host/run.ts";
import { TabRegistry } from "../../host/tabs.ts";
import { TrialRecorder } from "../../host/trial.ts";
import { BASE, FakeBrowser } from "./fake-adapter.ts";
import { freshDb } from "./harness.ts";

/** A part call as the core would hand it over (all arguments present, as the closed schema wants). */
export const call = <P extends PartCall["part"]>(
	part: P,
	args: Extract<PartCall, { part: P }>["args"],
) => ({ part, args }) as Extract<PartCall, { part: P }>;

export const KAEDE = `${BASE}sites/kaede-shop/base/`;
export const HOSHI = `${BASE}sites/hoshikuzu/base/index.html`;

export type PartsSetup = Awaited<ReturnType<typeof setupParts>>;

/**
 * The Arm 1 stack without the run loop: the host's executor (ledger, gate, policy) under the part executor,
 * a fake browser opened on `start`, and a capture directory of its own. Parts are called directly, so a
 * test sees exactly what a part answers.
 */
export async function setupParts(
	options: {
		start?: string;
		request?: string;
		approver?: Approver;
		adapter?: FakeBrowser;
		policy?: UrlPolicy;
		core?: PartsHelpers;
		goal?: string;
		sources?: readonly string[];
		captureDir?: string;
	} = {},
) {
	const db = freshDb();
	const adapter = options.adapter ?? new FakeBrowser();
	await adapter.open();
	const runId = randomUUID();
	const nowIso = new Date().toISOString();
	write(db, () => {
		createRun(db, LAB_OWNER, {
			runId,
			skillRef: "arm1:parts@1",
			skillDigest: "digest",
			catalogRef: "catalog",
			catalogDigest: "digest",
			platform: "playwright-mcp",
			coreFormatVersion: 1,
			policy: { maxModelCalls: 12, retries: { default: 1 } },
			nowIso,
		});
		transitionRun(db, LAB_OWNER, runId, "running", { nowIso });
	});
	const dir =
		options.captureDir ?? mkdtempSync(join(tmpdir(), "interact-parts-"));
	const control = new RunControl();
	const recorder = new TrialRecorder(Date.now);
	const grants = new InputGrants(Date.now, randomUUID);
	const tabs = new TabRegistry();
	const executor = createExecutor({
		db,
		owner: LAB_OWNER,
		runId,
		sessionId: randomUUID(),
		adapter,
		policy: options.policy ?? fixturePolicy(BASE),
		tabs,
		grants,
		approver: options.approver ?? new FixtureApprover({ decision: "grant" }),
		recorder,
		logger: silentLabLogger,
		control,
		now: Date.now,
		newId: randomUUID,
		request: options.request ?? "",
		followOwnNavigation: true,
	});
	const first = await executor.start(options.start ?? `${KAEDE}index.html`);
	const parts = createPartExecutor({
		knowledge: labKnowledgePort(db, LAB_OWNER),
		executor,
		tabs,
		recorder,
		captures: new CaptureStore({ runId, dir }),
		grants,
		request: options.request ?? "",
		events: labEventsPort(silentLabLogger, runId),
		...(options.core ? { core: options.core } : {}),
		...(options.goal !== undefined ? { goal: options.goal } : {}),
		...(options.sources ? { sources: () => options.sources ?? [] } : {}),
	});
	const summary = parts.begin(first);
	return {
		db,
		adapter,
		runId,
		dir,
		control,
		recorder,
		grants,
		tabs,
		executor,
		parts,
		summary,
		/** The part's result; fails the test when the part ended the run or stopped for approval instead. */
		async result(part: PartCall): Promise<PartResult> {
			const executed = await parts.run(part);
			if (executed.kind !== "outcome" || executed.outcome.kind !== "part")
				throw new Error(`not a part result: ${JSON.stringify(executed)}`);
			return executed.outcome.result;
		},
		run: (part: PartCall): Promise<Executed> => parts.run(part),
		operations: () => listOperations(db, LAB_OWNER, runId),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** The id of the item with this role and name in a summary, a candidate list or a form. */
export function idOf(
	items: readonly { item: string; role: string; name: string }[] | undefined,
	role: string,
	name: string,
): string {
	const hit = items?.find((i) => i.role === role && i.name === name);
	if (!hit) throw new Error(`no ${role} "${name}" in ${JSON.stringify(items)}`);
	return hit.item;
}
