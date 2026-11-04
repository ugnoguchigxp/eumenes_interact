import { parseCaptureDir } from "./arm.ts";
import type { Database } from "bun:sqlite";
import { StopApprover, CliApprover, printable } from "../host/approval.ts";
import { RunControl } from "../host/control.ts";
import {
	runDefinition,
	type DefinitionRunResult,
} from "../host/definition-run.ts";
import { loadDefinitions } from "../host/definitions.ts";
import type { LabLogger } from "../host/log.ts";
import {
	DEFAULT_OBSERVATIONS_DIR,
	createObservationSink,
	pruneObservations,
} from "../host/observations.ts";
import { importSeed, loadSeeds } from "../knowledge/seed.ts";
import { LAB_OWNER } from "../host/run.ts";
import { createSession, type BrowserOptions } from "./session.ts";

/** `--input key=value`: the first `=` splits, so a value may contain one. */
export function parseInputs(pairs: readonly string[]): Record<string, string> {
	const inputs: Record<string, string> = {};
	for (const pair of pairs) {
		const at = pair.indexOf("=");
		if (at <= 0) throw new Error("input_must_be_key=value");
		const key = pair.slice(0, at);
		if (Object.hasOwn(inputs, key)) throw new Error(`input_given_twice:${key}`);
		inputs[key] = pair.slice(at + 1);
	}
	return inputs;
}

export async function taskList(): Promise<string[]> {
	return (await loadDefinitions()).map(({ definition: d }) =>
		[
			`${d.id}@${d.revision}`,
			d.title,
			`inputs: ${Object.keys(d.inputs.properties).join(", ") || "-"}`,
			`origins: ${d.allowedOrigins.join(" ")}`,
		].join("\t"),
	);
}

export type TaskRunOptions = BrowserOptions & {
	definitionId: string;
	inputs: Record<string, string>;
	json: boolean;
	keepObservations: boolean;
	approver: "stop" | "cli";
	/** An existing absolute directory for screenshots (refused before anything starts when it is not one). */
	captureDir?: string;
};

/** What a person reads when `--json` is not given. The text is a page's, so it is made safe to print. */
export function humanSummary(result: DefinitionRunResult): string[] {
	const { id, revision, digest } = result.definition;
	const lines = [
		`definition\t${id}@${revision}\t${digest.slice(0, 12)}`,
		`status\t${result.status}${result.code ? ` (${result.code})` : ""}\t${result.ok ? "ok" : "not ok"}`,
		`final url\t${printable(result.finalUrl ?? "-", 300)}`,
		"steps",
		...result.steps.map(
			(s) =>
				`  ${s.id}\t${s.action}\t${s.status}${s.code ? ` (${s.code})` : ""}`,
		),
	];
	if (result.issues)
		lines.push(
			"issues",
			...result.issues.map((i) => `  ${i.path || "-"}\t${i.code}`),
		);
	if (result.approval)
		lines.push(
			`needs approval\t${result.approval.action}\t${printable(result.approval.element)}\t${printable(result.approval.page)}`,
		);
	for (const [stepId, x] of Object.entries(result.extracts))
		lines.push(
			`extract ${stepId}\t${x.charCount} chars${x.truncated ? " (truncated)" : ""}\troot ${x.root}\t${printable(x.title ?? "", 120)}`,
			`  ${printable(x.text, 500)}`,
		);
	return lines;
}

/**
 * Runs one shipped definition with the inputs given. The site knowledge of the repository is imported first
 * (idempotent), so one command is enough. Exit code: 0 ok, 1 the run did not complete, 2 the definition or an
 * input was refused before any run.
 */
export async function taskRun(
	db: Database,
	options: TaskRunOptions,
	logger: LabLogger,
): Promise<number> {
	const found = (await loadDefinitions()).find(
		({ definition }) => definition.id === options.definitionId,
	);
	if (!found) throw new Error(`definition_not_found:${options.definitionId}`);
	// Refused before a browser is started.
	const captureDir = parseCaptureDir(options.captureDir);
	console.error(
		"notice: task run visits the real sites its definition allows; start it only when you have decided to (user-triggered, plan §10.2).",
	);
	const nowIso = new Date().toISOString();
	for (const { seed } of await loadSeeds())
		importSeed(db, LAB_OWNER, seed, nowIso);
	// Observation bodies of earlier runs that outlived their week go first (plan.md §14).
	await pruneObservations(DEFAULT_OBSERVATIONS_DIR, Date.now());
	const control = new RunControl();
	const onSigint = () => control.cancel("cancel");
	process.on("SIGINT", onSigint);
	const session = await createSession({ ...options, netGuard: true }, logger);
	try {
		const result = await runDefinition({
			db,
			definition: found.definition,
			inputs: options.inputs,
			adapter: session.adapter,
			approver:
				options.approver === "cli" ? new CliApprover() : new StopApprover(),
			logger,
			control,
			...(captureDir ? { captureDir } : {}),
			...(options.keepObservations
				? { observationSink: createObservationSink(DEFAULT_OBSERVATIONS_DIR) }
				: {}),
		});
		if (options.json) console.log(JSON.stringify(result, null, 2));
		else {
			for (const line of humanSummary(result)) console.log(line);
			if (options.keepObservations && result.runId)
				console.log(
					`observations\t${DEFAULT_OBSERVATIONS_DIR}/${result.runId}`,
				);
		}
		return result.ok ? 0 : result.status === "rejected" ? 2 : 1;
	} finally {
		process.off("SIGINT", onSigint);
		await session.dispose();
	}
}
