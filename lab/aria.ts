/**
 * Name folding for the scripted arm: width, surrounding space. Snapshot trees are read by the package
 * (`parseNodes`); this file no longer parses them.
 */

export const normalize = (text: string) =>
	text.normalize("NFKC").trim().replace(/\s+/g, " ");
