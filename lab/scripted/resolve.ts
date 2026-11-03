import type { ChatMessage } from "eumenes-interact";
import type { Target } from "./script.ts";

/**
 * Finds a target in the latest observation by role and accessible name, and reads that observation and the
 * tab list out of the messages the core hands to inference (REFERENCE and TOOL_RESULT). Refs are looked up
 * here at run time; a script never carries one.
 */

export type AriaNode = {
	role: string;
	name: string | null;
	ref: string | null;
	parents: AriaNode[];
};

const normalize = (s: string) =>
	s.normalize("NFKC").trim().replace(/\s+/g, " ");

/** `- link "name" [ref=e3] [cursor=pointer]:` and `- main [ref=e7]:`; `- text:` and `- /url:` lines are no element. */
const LINE =
	/^(\s*)- ([A-Za-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::.*)?$/;
const REF = /\[ref=([A-Za-z0-9_-]+)\]/;

export function parseAria(body: string): AriaNode[] {
	const nodes: AriaNode[] = [];
	const stack: { indent: number; node: AriaNode }[] = [];
	for (const raw of body.split("\n")) {
		const m = LINE.exec(raw.replace(/\t/g, "  "));
		if (!m) continue;
		// `- text:` is page text, not an element.
		if (m[2] === "text") continue;
		const indent = m[1]!.length;
		while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
		const node: AriaNode = {
			role: m[2]!,
			name: m[3] === undefined ? null : normalize(m[3].replace(/\\(.)/g, "$1")),
			ref: REF.exec(m[4] ?? "")?.[1] ?? null,
			parents: stack.map((s) => s.node),
		};
		nodes.push(node);
		stack.push({ indent, node });
	}
	return nodes;
}

export type Resolved =
	{ kind: "found"; ref: string } | { kind: "none" | "ambiguous" };

/** Exactly one element with that role and name (below the `within` ancestors) must carry a ref. */
export function resolveTarget(body: string, target: Target): Resolved {
	const name = normalize(target.name);
	const hits = parseAria(body).filter(
		(n) =>
			n.ref !== null &&
			n.role === target.role &&
			n.name === name &&
			(target.within ?? []).every((a) =>
				n.parents.some(
					(p) =>
						p.role === a.role &&
						(a.name === undefined || p.name === normalize(a.name)),
				),
			),
	);
	if (hits.length === 0) return { kind: "none" };
	return hits.length === 1
		? { kind: "found", ref: hits[0]!.ref! }
		: { kind: "ambiguous" };
}

export type SeenObservation = { observationRef: string; text: string };
export type SeenTab = { tabRef: string; title: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** The host-authored data messages, parsed, oldest first. */
function dataMessages(
	messages: readonly ChatMessage[],
): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	messages.forEach((m, index) => {
		if (m.role !== "user") return;
		const marks = [
			index === 1 ? "\nREFERENCE=" : null,
			m.content.startsWith("TOOL_RESULT=") ? "TOOL_RESULT=" : null,
		];
		const mark = marks.find((x) => x !== null && m.content.includes(x));
		if (!mark) return;
		try {
			const data: unknown = JSON.parse(
				m.content.slice(m.content.indexOf(mark) + mark.length),
			);
			if (isRecord(data)) out.push(data);
		} catch {
			// Not data the core wrote.
		}
	});
	return out;
}

/** The most recent observation still alive: older ones are folded into a one-line stub string. */
export function latestObservation(
	messages: readonly ChatMessage[],
): SeenObservation | null {
	for (const data of dataMessages(messages).reverse()) {
		const o = data.observation;
		if (
			isRecord(o) &&
			typeof o.observationRef === "string" &&
			typeof o.text === "string"
		)
			return { observationRef: o.observationRef, text: o.text };
	}
	return null;
}

export function latestTabs(messages: readonly ChatMessage[]): SeenTab[] | null {
	for (const data of dataMessages(messages).reverse()) {
		if (Array.isArray(data.tabs))
			return data.tabs.flatMap((t: unknown) =>
				isRecord(t) &&
				typeof t.tabRef === "string" &&
				typeof t.title === "string"
					? [{ tabRef: t.tabRef, title: t.title }]
					: [],
			);
	}
	return null;
}
