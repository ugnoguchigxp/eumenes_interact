/**
 * Image headers, read by the adapter itself: the dimensions an adapter reports are never taken from
 * the platform's say-so, and an image the header does not describe is not an image.
 */

/** Hard bounds on what an adapter hands back: pixels per side and bytes. */
export const IMAGE_MAX_SIDE = 16_384;
export const IMAGE_MAX_BYTES = 40 * 1024 * 1024;

export type ImageInfo = {
	mediaType: "image/png" | "image/jpeg";
	width: number;
	height: number;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The start-of-frame markers of a JPEG (all but the tables and the arithmetic-coding switch). */
const isStartOfFrame = (marker: number) =>
	marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

function pngInfo(bytes: Uint8Array): ImageInfo | undefined {
	// Signature, then the IHDR chunk: length 13, "IHDR", width and height as big-endian u32.
	if (bytes.length < 24 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b))
		return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
		return undefined;
	return {
		mediaType: "image/png",
		width: view.getUint32(16),
		height: view.getUint32(20),
	};
}

function jpegInfo(bytes: Uint8Array): ImageInfo | undefined {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
		return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// Walk the segments up to the first start of frame: marker, length, then (precision, height, width).
	let offset = 2;
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) return undefined;
		const marker = bytes[offset + 1] as number;
		if (marker === 0xff) {
			offset += 1;
			continue;
		}
		// Standalone markers (TEM, RSTn, SOI) carry no length.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			offset += 2;
			continue;
		}
		const length = view.getUint16(offset + 2);
		if (isStartOfFrame(marker)) {
			if (length < 8 || offset + 9 > bytes.length) return undefined;
			return {
				mediaType: "image/jpeg",
				height: view.getUint16(offset + 5),
				width: view.getUint16(offset + 7),
			};
		}
		if (length < 2) return undefined;
		offset += 2 + length;
	}
	return undefined;
}

/** PNG or JPEG, from the header; `undefined` for anything else or a truncated header. */
export const imageInfo = (bytes: Uint8Array): ImageInfo | undefined =>
	pngInfo(bytes) ?? jpegInfo(bytes);

/** Whether the dimensions are positive and within the hard bound. */
export const withinBounds = (info: ImageInfo): boolean =>
	info.width > 0 &&
	info.height > 0 &&
	info.width <= IMAGE_MAX_SIDE &&
	info.height <= IMAGE_MAX_SIDE;
