import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { ApprovalAction } from "./gate.ts";

/** The approver port (plan.md §9). The host asks; the answer is data, never the model's claim. */

export type ApprovalDecision = "grant" | "deny";

/** What the user sees: where, what and (for typing) which content. Never page text beyond the element's name. */
export type ApprovalPrompt = {
	approvalId: string;
	operationId: string;
	tabRef: string;
	/** Origin and path of the page; query and fragment can carry secrets. */
	page: string;
	action: ApprovalAction;
	element: string;
	summary: string;
	/** What would be typed; only for `type`. */
	content?: string;
};

/**
 * Text from a page or the model, made safe to print: ANSI/OSC sequences, every control character (C0, DEL,
 * C1, so CR and LF too), Unicode line separators and bidirectional overrides are dropped, and the length is
 * capped, so a crafted accessible name cannot forge lines of the prompt.
 */
const MAX_PRINTED = 200;
/* eslint-disable no-control-regex */
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */
export function printable(text: string, max: number = MAX_PRINTED): string {
	const cleaned = text
		.replace(ANSI_CSI, "")
		.replace(ANSI_OSC, "")
		.replace(UNSAFE, " ")
		.replace(/ {2,}/g, " ")
		.trim();
	return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export interface Approver {
	decide(
		prompt: ApprovalPrompt,
		signal: AbortSignal,
	): Promise<ApprovalDecision>;
}

/** Fixture runs: the case file holds the simulated user's answer (`approvalScript`). */
export class FixtureApprover implements Approver {
	constructor(private readonly script: { decision: ApprovalDecision }) {}

	decide(): Promise<ApprovalDecision> {
		return Promise.resolve(this.script.decision);
	}
}

/**
 * Unattended runs of work definitions: nothing is ever granted. The first prompt is kept, so the run can
 * stop as `needs_input` and tell the caller what it would have done (plan.md §9).
 */
export class StopApprover implements Approver {
	prompt: ApprovalPrompt | null = null;

	decide(prompt: ApprovalPrompt): Promise<ApprovalDecision> {
		this.prompt ??= prompt;
		return Promise.resolve("deny");
	}
}

/** Live runs: shows target, action and content on the terminal and waits for y/N. Anything else denies. */
export class CliApprover implements Approver {
	constructor(
		private readonly input: Readable = process.stdin,
		private readonly output: Writable = process.stderr,
	) {}

	async decide(
		prompt: ApprovalPrompt,
		signal: AbortSignal,
	): Promise<ApprovalDecision> {
		const lines = [
			"",
			"承認が必要な操作です",
			`  ページ: ${printable(prompt.page)}`,
			`  操作: ${printable(prompt.action)}`,
			`  対象: ${printable(prompt.element)}`,
			...(prompt.content === undefined
				? []
				: [`  入力内容: ${printable(prompt.content)}`]),
			`  内容: ${printable(prompt.summary)}`,
		];
		this.output.write(`${lines.join("\n")}\n`);
		const rl = createInterface({
			input: this.input,
			output: this.output,
			terminal: false,
		});
		try {
			// A closed input (EOF) never answers the question: it counts as an empty answer.
			const eof = new Promise<string>((resolve) =>
				rl.once("close", () => resolve("")),
			);
			const answer = await Promise.race([
				rl.question("承認しますか [y/N] ", { signal }),
				eof,
			]);
			return /^y(es)?$/i.test(answer.trim()) ? "grant" : "deny";
		} catch {
			// An abort (cancel, deadline) or a closed input is not an approval.
			return "deny";
		} finally {
			rl.close();
		}
	}
}

/** The window an approval stays valid, as in Eumenes (`APPROVAL_MS`). */
const APPROVAL_MS = 10 * 60_000;

export type ApprovalBinding = {
	tabRef: string;
	page: string;
	action: ApprovalAction;
	element: string;
	/** Digest of the typed value (type only). */
	valueDigest: string | null;
};

/**
 * Granted approvals. One approval is for one operation: same tab, page, kind of action, element and typed
 * value; it is used once and expires (Eumenes `consumeApproval`). A past approval never allows a later send.
 */
export class ApprovalLedger {
	private readonly granted = new Map<
		string,
		{ binding: ApprovalBinding; until: number }
	>();

	constructor(private readonly now: () => number) {}

	grant(approvalId: string, binding: ApprovalBinding) {
		this.granted.set(approvalId, {
			binding,
			until: this.now() + APPROVAL_MS,
		});
	}

	/** True once, when the approval exists, is unexpired and matches `binding`. */
	consume(approvalId: string, binding: ApprovalBinding): boolean {
		const entry = this.granted.get(approvalId);
		if (!entry || entry.until <= this.now()) return false;
		this.granted.delete(approvalId);
		const b = entry.binding;
		return (
			b.tabRef === binding.tabRef &&
			b.page === binding.page &&
			b.action === binding.action &&
			b.element === binding.element &&
			b.valueDigest === binding.valueDigest
		);
	}
}
