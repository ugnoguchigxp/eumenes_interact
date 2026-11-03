/** Tiny valid image headers for tests. */

/** A PNG up to and including its IHDR chunk (enough for the header). */
export function png(width: number, height: number) {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const view = new DataView(bytes.buffer);
	view.setUint32(8, 13);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

/** A JPEG: SOI, an APP0 segment, a table segment, then a start of frame (`marker`), then padding. */
export function jpeg(width: number, height: number, marker = 0xc0) {
	const app0 = [
		0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1,
		0, 0,
	];
	const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
	const sof = [
		0xff,
		marker,
		0x00,
		0x0b,
		0x08,
		height >> 8,
		height & 0xff,
		width >> 8,
		width & 0xff,
		0x01,
		0x01,
		0x11,
		0x00,
	];
	return new Uint8Array([0xff, 0xd8, ...app0, ...dht, ...sof, 0xff, 0xd9]);
}
