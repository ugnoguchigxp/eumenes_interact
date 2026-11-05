import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ApprovalDecision, ApprovalPrompt, Approver } from "./approval.ts";

/**
 * A host-owned allowlist for clicks the approval gate would otherwise stop (review 2026-11-05, owner: "Vimeo
 * is not to be pressed; manage it with a whitelist"). The file names origins and action *kinds*; what each kind
 * matches is fixed here, so the file cannot widen a grant to arbitrary buttons. Whatever is not listed goes to
 * the fallback approver (unattended: deny → `needs_input`), never to a silent success.
 */

/** The action kinds a file may grant, and the element names each one matches (whole name, case-insensitive). */
export const ACTION_KINDS = {
	"media.play": /^(?:play|再生)(?:\s*\((?:k|space)\)|\s+keyboard shortcut k|（k）)?$/iu,
	"media.pause": /^(?:pause|一時停止)(?:\s*\((?:k|space)\)|\s+keyboard shortcut k|（k）)?$/iu,
} as const;
export type ActionKind = keyof typeof ACTION_KINDS;

export type AllowlistEntry = { origin: string; actions: ActionKind[] };

export const DEFAULT_ALLOWLIST_PATH = fileURLToPath(
	new URL("../config/action-allowlist.json", import.meta.url),
);

/** Reads and checks the file; an unknown kind or a non-https origin is an error, not a silent skip. */
export function loadAllowlist(
	path: string = DEFAULT_ALLOWLIST_PATH,
): AllowlistEntry[] {
	const raw = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
	if (!Array.isArray(raw.entries)) throw new Error("allowlist_invalid:entries");
	return raw.entries.map((e, i) => {
		const entry = e as { origin?: unknown; actions?: unknown };
		if (typeof entry.origin !== "string")
			throw new Error(`allowlist_invalid:${i}:origin`);
		const url = new URL(entry.origin);
		if (url.protocol !== "https:" || url.origin !== entry.origin)
			throw new Error(`allowlist_invalid:${i}:origin`);
		if (!Array.isArray(entry.actions) || entry.actions.length === 0)
			throw new Error(`allowlist_invalid:${i}:actions`);
		for (const a of entry.actions)
			if (typeof a !== "string" || !(a in ACTION_KINDS))
				throw new Error(`allowlist_invalid:${i}:action:${String(a)}`);
		return { origin: url.origin, actions: entry.actions as ActionKind[] };
	});
}

/** The kind a prompt is granted under, or null. Only clicks; typing and key presses always go to the fallback. */
export function allowedKind(
	entries: readonly AllowlistEntry[],
	prompt: Pick<ApprovalPrompt, "page" | "action" | "element">,
): ActionKind | null {
	if (prompt.action !== "click") return null;
	let origin: string;
	try {
		origin = new URL(prompt.page).origin;
	} catch {
		return null;
	}
	// The gate names the element as `<role> "<name>"` (e.g. `button "Play (k)"`); only buttons are granted.
	const named = /^button\s+"(.*)"$/su.exec(prompt.element.trim());
	if (!named) return null;
	const element = named[1]!.trim();
	for (const entry of entries) {
		if (entry.origin !== origin) continue;
		for (const kind of entry.actions)
			if (ACTION_KINDS[kind].test(element)) return kind;
	}
	return null;
}

export class AllowlistApprover implements Approver {
	constructor(
		private readonly entries: readonly AllowlistEntry[],
		private readonly fallback: Approver,
		private readonly notify: (line: string) => void = () => {},
	) {}

	decide(
		prompt: ApprovalPrompt,
		signal: AbortSignal,
	): Promise<ApprovalDecision> {
		const kind = allowedKind(this.entries, prompt);
		if (kind) {
			this.notify(`allowlist\tgrant\t${kind}\t${new URL(prompt.page).origin}`);
			return Promise.resolve("grant");
		}
		this.notify(`allowlist\tnot_listed\t${prompt.action}\t${prompt.page}`);
		return this.fallback.decide(prompt, signal);
	}
}
