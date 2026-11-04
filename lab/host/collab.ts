import { createCollaborationContract } from "eumenes-collaboration";
import type { InferencePort } from "eumenes-interact";

/**
 * The collaboration agent's output contract driving the browser capability (v3 §M2). The model answers with a
 * collaboration action; this adapter turns it into the part call the operation core runs:
 * - `invoke` <part> + arguments  → that part
 * - `invoke` "done" + text       → the operation completes with `text` as its answer (evidence in arguments)
 * - `reply` text                 → the turn ends awaiting the user (the operation is `needs_input`, clarify)
 * `return` and `discard` have no browser meaning and are passed on unchanged, so the core rejects them.
 * The session itself stays open until the user says it is done (`decideSession` in eumenes-collaboration);
 * the operation's own status (completed / needs_input / stopped) is what the golden compares.
 */
export const collabContract = createCollaborationContract({
	maxChars: 2000,
	maxSentences: 40,
	validate: () => true,
	measure: (text) => ({
		chars: text.length,
		sentences: text.split(/[。.!?！？]/).filter(Boolean).length,
	}),
	description:
		"利用者への返答。操作の完了報告か、作業を進めるための質問を一つ。",
});

function json(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/** A collaboration action as the operation core's part call; anything else unchanged. */
export function collabToPart(raw: string): string {
	const action = collabContract.parse(json(raw));
	if (!action) return raw;
	if (action.kind === "reply")
		return JSON.stringify({ part: "ask", args: { question: action.text } });
	if (action.kind !== "invoke") return raw;
	if (action.tool === "done")
		return JSON.stringify({
			part: "done",
			args: {
				answer: action.text ?? "",
				evidence: Array.isArray(action.arguments.evidence)
					? action.arguments.evidence
					: [],
			},
		});
	return JSON.stringify({ part: action.tool, args: action.arguments });
}

/** The reverse, for converting the recorded scripted part calls into collaboration actions. */
export function partToCollab(raw: string): string {
	const call = json(raw) as
		{ part?: string; args?: Record<string, unknown> } | undefined;
	if (!call || typeof call.part !== "string") return raw;
	const args = call.args ?? {};
	if (call.part === "ask")
		return JSON.stringify({
			action: "reply",
			text: String(args.question ?? ""),
		});
	if (call.part === "done")
		return JSON.stringify({
			action: "invoke",
			tool: "done",
			arguments: { evidence: args.evidence ?? [] },
			text: String(args.answer ?? ""),
		});
	return JSON.stringify({ action: "invoke", tool: call.part, arguments: args });
}

const ROOT = new URL("../../skills/", import.meta.url);

/** The browse skill's body (frontmatter removed), checked against the digest in `skills/manifest.json`. */
export async function loadBrowseSkill(): Promise<string> {
	const manifest = (await Bun.file(new URL("manifest.json", ROOT)).json()) as {
		skills: { browse: { sha256: string } };
	};
	const bytes = await Bun.file(new URL("browse/SKILL.md", ROOT)).text();
	const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	if (digest !== manifest.skills.browse.sha256)
		throw new Error("skill_digest_mismatch:browse");
	return bytes.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

/**
 * Wraps a collaboration-speaking inference so the operation core receives part calls. With `skill`, the
 * skill's text replaces the core's part-format system message: the agent's know-how lives in the skill.
 */
export function collabAgentPort(
	inner: InferencePort,
	skill?: string,
): InferencePort {
	return {
		async complete(request) {
			const { outputSchema: _parts, ...rest } = request;
			const outcome = await inner.complete({
				...rest,
				messages:
					skill === undefined
						? rest.messages
						: rest.messages.map((m, i) =>
								i === 0 && m.role === "system" ? { ...m, content: skill } : m,
							),
				outputSchema: collabContract.outputSchema as Record<string, unknown>,
			});
			return outcome.kind === "text"
				? { ...outcome, text: collabToPart(outcome.text) }
				: outcome;
		},
	};
}

/** A part-speaking scripted inference re-expressed as the collaboration agent's outputs. */
export function collabScripted(parts: InferencePort): InferencePort {
	return {
		async complete(request) {
			const outcome = await parts.complete(request);
			return outcome.kind === "text"
				? { ...outcome, text: partToCollab(outcome.text) }
				: outcome;
		},
	};
}
