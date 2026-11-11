import { utf8Length } from "./utf8-length.ts";

/**
 * What the host lets the model see of one snapshot (Eumenes `api/domains/browser/contracts/index.ts`, spec
 * §5.5, commit 98b188d2); the rest is not actionable.
 */
const SNAPSHOT_MAX_BYTES = 32 * 1024;
const SNAPSHOT_MAX_DEPTH = 12;
const SNAPSHOT_MAX_REFS = 200;

export type BoundedSnapshot = {
	text: string;
	truncated: boolean;
	reasons: ("bytes" | "depth" | "refs")[];
	/** The element refs that appear in `text`; nothing else may be acted on. */
	refs: string[];
};

/**
 * An element ref inside a bracket (`[ref=e1]`, or after other attributes: `[checked=false, ref=e322]`).
 * A platform extension, not Eumenes behaviour; the body itself is never rewritten (plan.md §5.3).
 * Prose that merely contains `ref=` is not a ref. The actionable set of a whole snapshot is `refsOf`
 * in `parts/snapshot.ts`, which reads these tokens through the one node parser.
 */
export function refsIn(text: string): string[] {
	return [...text.matchAll(/(?:\[|,\s*)ref=([A-Za-z0-9_-]+)/g)].map(
		(match) => match[1]!,
	);
}

/**
 * Cuts an ARIA snapshot at whole-node boundaries (a node is a `- ` line with its continuation lines).
 * Nodes are taken in document order until the byte or ref budget would be exceeded; nodes deeper than
 * the depth limit are left out with their subtrees. Ported from Eumenes `api/domains/browser/service/
 * observation.ts`; `compactSnapshot` there serves only research collection and is not ported.
 */
export function boundSnapshot(
	snapshot: string,
	limits = {
		bytes: SNAPSHOT_MAX_BYTES,
		depth: SNAPSHOT_MAX_DEPTH,
		refs: SNAPSHOT_MAX_REFS,
	},
): BoundedSnapshot {
	const nodes = snapshotNodes(snapshot);
	const kept: string[] = [];
	const refs: string[] = [];
	const reasons = new Set<"bytes" | "depth" | "refs">();
	let bytes = 0;
	for (const node of nodes) {
		if (node.level >= limits.depth) {
			reasons.add("depth");
			continue;
		}
		const text = node.lines.join("\n");
		const size = utf8Length(text) + 1;
		const found = refsIn(text);
		if (bytes + size > limits.bytes) {
			reasons.add("bytes");
			break;
		}
		if (refs.length + found.length > limits.refs) {
			reasons.add("refs");
			break;
		}
		kept.push(text);
		refs.push(...found);
		bytes += size;
	}
	return {
		text: kept.join("\n"),
		truncated: reasons.size > 0,
		reasons: [...reasons],
		refs,
	};
}

/** ARIA node boundaries for bounding. */
export function snapshotNodes(snapshot: string) {
	const nodes: { level: number; lines: string[] }[] = [];
	for (const raw of snapshot.split("\n")) {
		const line = raw.replace(/\r$/, "").replace(/\t/g, "  ");
		if (!line.trim()) continue;
		const trimmed = line.trimStart();
		const last = nodes.at(-1);
		if ((trimmed.startsWith("- ") && !trimmed.startsWith("- /url:")) || !last)
			nodes.push({
				level: Math.floor((line.length - trimmed.length) / 2),
				lines: [line],
			});
		else last.lines.push(line);
	}
	return nodes;
}
