import { ancestors, parseNodes, type Node } from "./snapshot.ts";

/**
 * A stored locator matched against one snapshot. The tree is `parseNodes` (the same reader the parts use).
 * Names are width-folded and trimmed, and a blank name counts as unnamed, which is how locators were matched
 * before they shared that tree.
 */

const normalize = (text: string) =>
	text.normalize("NFKC").trim().replace(/\s+/g, " ");

export type SnapshotMatch = {
	ref: string;
	role: string;
	name: string | null;
};

export type SnapshotCandidateResolution =
	| { kind: "found"; match: SnapshotMatch }
	| { kind: "none" | "ambiguous" | "unsupported" };

type Fields = Readonly<Record<string, string | number | boolean>>;

const textOf = (fields: Fields, key: string): string | undefined => {
	const value = fields[key];
	return typeof value === "string" ? value : undefined;
};

/** `a|b` as a list of normalised alternatives. */
const alternatives = (value: string) =>
	value
		.split("|")
		.map(normalize)
		.filter((item) => item !== "");

const isTrue = (value: string | number | boolean | undefined) =>
	value === true || value === "true";

/** The link text as written and as a person would read it (`%E7%89%B9…` is `特…`). */
function urlVariants(url: string): string[] {
	try {
		return [url, decodeURIComponent(url)];
	} catch {
		return [url];
	}
}

const hasAny = (url: string, needles: readonly string[]) =>
	urlVariants(url).some((variant) =>
		needles.some((needle) => variant.includes(needle)),
	);

type Located = {
	ref: string;
	role: string;
	name: string | null;
	url: string | null;
	parents: Node[];
};

/** One element a locator may name. Text nodes are page text, not elements. */
function located(nodes: readonly Node[], node: Node): Located | null {
	if (node.ref === null || node.role === "text") return null;
	const name = normalize(node.name);
	return {
		ref: node.ref,
		role: node.role,
		name: name === "" ? null : name,
		url: node.url,
		parents: ancestors(nodes, node),
	};
}

/** One candidate against the whole observation body. */
export function resolveCandidate(
	body: string,
	candidate: { kind: string; fields: Fields },
): SnapshotCandidateResolution {
	if (candidate.kind !== "role" && candidate.kind !== "structure")
		return { kind: "unsupported" };
	const { fields } = candidate;
	const role = textOf(fields, "role");
	if (role === undefined) return { kind: "unsupported" };
	const name = textOf(fields, "name");
	const anyOf = textOf(fields, "nameAnyOf");
	const names =
		name !== undefined
			? [normalize(name)]
			: anyOf !== undefined
				? alternatives(anyOf)
				: null;
	const include = textOf(fields, "urlIncludes");
	const exclude = textOf(fields, "urlExcludes");
	const within = textOf(fields, "withinRole");
	const named = isTrue(fields["named"]);
	const nodes = parseNodes(body);
	const hits = nodes.flatMap((node) => {
		const element = located(nodes, node);
		if (element === null) return [];
		if (element.role !== role) return [];
		if (
			names !== null &&
			(element.name === null || !names.includes(element.name))
		)
			return [];
		if (named && (element.name === null || element.name === "")) return [];
		if (
			include !== undefined &&
			(element.url === null || !hasAny(element.url, [include]))
		)
			return [];
		if (
			exclude !== undefined &&
			element.url !== null &&
			hasAny(element.url, alternatives(exclude))
		)
			return [];
		if (
			within !== undefined &&
			!element.parents.some((parent) => parent.role === within)
		)
			return [];
		return [element];
	});
	const nth = fields["nth"] === undefined ? null : Number(fields["nth"]);
	if (nth !== null && (!Number.isInteger(nth) || nth < 0))
		return { kind: "unsupported" };
	const pick = nth === null ? hits[0] : hits[nth];
	if (!pick) return { kind: "none" };
	if (nth === null && hits.length > 1) return { kind: "ambiguous" };
	return {
		kind: "found",
		match: { ref: pick.ref, role: pick.role, name: pick.name },
	};
}
