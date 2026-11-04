import { printable } from "../host/approval.ts";
import { parseEffort, parseMaxTokens } from "../host/claude.ts";
import { parseArm } from "./arm.ts";
import {
	startOperate,
	validateOperate,
	type OperateOptions,
	type OperateSnapshot,
} from "../host/operate.ts";

export type OperateFlags = {
	request?: string | undefined;
	"start-url"?: string | undefined;
	"allow-origin"?: string[] | undefined;
	inference?: string | undefined;
	model?: string | undefined;
	effort?: string | undefined;
	"max-tokens"?: string | undefined;
	arm?: string | undefined;
	"capture-dir"?: string | undefined;
	"max-calls"?: string | undefined;
	approver?: string | undefined;
	headed?: boolean | undefined;
	headless?: boolean | undefined;
	"keep-observations"?: boolean | undefined;
	db?: string | undefined;
};

/** The flags of `operate` as the host API's options; everything wrong is found here, before anything starts. */
export function parseOperateFlags(flags: OperateFlags): OperateOptions {
	if (flags.request === undefined) throw new Error("operate_needs_request");
	if (flags["start-url"] === undefined)
		throw new Error("operate_needs_start_url");
	const allowedOrigins = flags["allow-origin"] ?? [];
	if (allowedOrigins.length === 0)
		throw new Error(
			"operate_needs_allow_origin: give --allow-origin at least once",
		);
	const inference = flags.inference ?? "claude";
	if (inference !== "claude" && inference !== "larm")
		throw new Error(`invalid_inference:${inference} (claude or larm)`);
	const approver = flags.approver ?? "stop";
	if (approver !== "stop" && approver !== "cli")
		throw new Error(`invalid_approver:${approver} (stop or cli)`);
	if (
		inference === "larm" &&
		(flags.model !== undefined ||
			flags.effort !== undefined ||
			flags["max-tokens"] !== undefined)
	)
		throw new Error("model_and_effort_are_for_claude");
	const maxCalls =
		flags["max-calls"] === undefined ? undefined : Number(flags["max-calls"]);
	const arm = parseArm(flags.arm, "arm1");
	const maxTokens = parseMaxTokens(flags["max-tokens"]);
	const options: OperateOptions = {
		arm,
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(flags["capture-dir"] === undefined
			? {}
			: { captureDir: flags["capture-dir"] }),
		request: flags.request,
		startUrl: flags["start-url"],
		allowedOrigins,
		inference,
		...(flags.model === undefined ? {} : { model: flags.model }),
		...(flags.effort === undefined
			? {}
			: { effort: parseEffort(flags.effort) }),
		...(maxCalls === undefined ? {} : { maxModelCalls: maxCalls }),
		headed: flags.headless !== true,
		approver,
		keepObservations: flags["keep-observations"] === true,
		...(flags.db === undefined ? {} : { dbPath: flags.db }),
	};
	validateOperate(options);
	return options;
}

const n = (value: number | null) => (value === null ? "-" : String(value));

/** The whole prompt: uncached input plus cache reads and writes (an unreported cache counter is no cache use). */
const promptTotal = (s: OperateSnapshot) =>
	s.tokens.input === null
		? null
		: s.tokens.input + (s.tokens.cacheRead ?? 0) + (s.tokens.cacheWrite ?? 0);

/** What a person reads. The text is the model's and the URL a page's, so both are made safe to print. */
export function operateSummary(s: OperateSnapshot): string[] {
	return [
		`status\t${s.status}${s.final?.code ? ` (${s.final.code})` : ""}`,
		`final\t${s.final?.kind ?? "-"}${s.final?.text ? `\t${printable(s.final.text, 500)}` : ""}`,
		`final url\t${printable(s.finalUrl ?? "-", 300)}`,
		`model calls\t${s.modelCalls}\toperations\t${s.operations}`,
		...(s.parts?.length ? [`parts\t${s.parts.join(" > ")}`] : []),
		...(s.captures?.length
			? [
					`captures\t${s.captures.length}\t${printable(s.captureDir ?? "-", 300)}`,
					...s.captures.map((name) => `  ${printable(name, 120)}`),
				]
			: []),
		`tokens\tuncached input ${n(s.tokens.input)}\toutput ${n(s.tokens.output)}\tcache read ${n(s.tokens.cacheRead)}\tcache write ${n(s.tokens.cacheWrite)}\tprompt total ${n(promptTotal(s))}`,
		`cost estimate (list prices, not a bill)\t${s.costUsdEstimate === null ? "-" : `$${s.costUsdEstimate.toFixed(4)}`}`,
		...(s.inference ? [`inference\t${JSON.stringify(s.inference)}`] : []),
		...(s.approval
			? [
					`needs approval\t${s.approval.action}\t${printable(s.approval.element ?? "")}\t${printable(s.approval.url ?? "")}`,
				]
			: []),
		`run id\t${s.runId}`,
	];
}

/** `operate`: start, wait, print. A cancel (SIGINT) ends the run as cancelled. Exit 0 only when it completed. */
export async function operateCommand(
	flags: OperateFlags,
	json: boolean,
): Promise<number> {
	const options = parseOperateFlags(flags);
	console.error(
		`notice: operate drives a real browser on the real site you named${options.inference === "claude" ? " and calls the Claude API with the key in your .env (costs money)" : " and calls the real LARM"}; start it only when you have decided to (user-triggered, plan §10.2, §10.5).`,
	);
	const handle = startOperate(options);
	const onSigint = () => handle.cancel();
	process.on("SIGINT", onSigint);
	try {
		const last = await handle.done;
		if (json) console.log(JSON.stringify(last, null, 2));
		else for (const line of operateSummary(last)) console.log(line);
		return last.status === "completed" ? 0 : 1;
	} finally {
		process.off("SIGINT", onSigint);
	}
}
