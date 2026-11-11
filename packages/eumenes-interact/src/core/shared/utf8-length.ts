/** UTF-8 length of a string in bytes; a lone surrogate counts as U+FFFD, as TextEncoder encodes it. */
export function utf8Length(text: string) {
	let bytes = 0;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return bytes;
}
