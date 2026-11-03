import type { ChatMessage } from "eumenes-interact";
import { normalize, parseAria } from "../aria.ts";
import type { Target } from "./script.ts";

/**
 * Finds a target in the latest observation by role and accessible name, and reads that observation and the
 * tab list out of the messages the core hands to inference (REFERENCE and TOOL_RESULT). Refs are looked up
 * here at run time; a script never carries one.
 */

export { normalize, parseAria, type AriaNode } from "../aria.ts";

export type Resolved =
	| { kind: "found"; ref: string; role: string; name: string | null }
	| { kind: "none" | "ambiguous" };

/**
 * The element with that role, name and destination (below the `within` ancestors) that carries a ref. More
 * than one is ambiguous unless `nth` names which; `nth` beyond the matches finds nothing.
 */
export function resolveTarget(body: string, target: Target): Resolved {
	const names = (
		target.name !== undefined ? [target.name] : (target.nameAnyOf ?? [])
	).map(normalize);
	const roles =
		target.roleAnyOf ?? (target.role === undefined ? [] : [target.role]);
	const hits = parseAria(body).filter(
		(n) =>
			n.ref !== null &&
			roles.includes(n.role) &&
			(names.length === 0 || (n.name !== null && names.includes(n.name))) &&
			(target.urlIncludes === undefined ||
				(n.url !== null && n.url.includes(target.urlIncludes))) &&
			(target.within ?? []).every((a) =>
				n.parents.some(
					(p) =>
						p.role === a.role &&
						(a.name === undefined || p.name === normalize(a.name)),
				),
			),
	);
	const pick = target.nth === undefined ? hits[0] : hits[target.nth];
	if (!pick) return { kind: "none" };
	if (target.nth === undefined && hits.length > 1) return { kind: "ambiguous" };
	return { kind: "found", ref: pick.ref!, role: pick.role, name: pick.name };
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
