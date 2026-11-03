/** NFKC, lower case, no whitespace, no digit-group commas ("5,000" equals "5000"). */
const squash = (s: string): string =>
	s
		.normalize("NFKC")
		.toLowerCase()
		.replace(/(?<=\d),(?=\d)/g, "")
		.replace(/\s+/g, "");

/** Whether `text` contains every fact. An empty fact list is trivially satisfied. */
export function includesAllFacts(
	text: string,
	facts: readonly string[],
): boolean {
	const haystack = squash(text);
	return facts.every((fact) => haystack.includes(squash(fact)));
}
