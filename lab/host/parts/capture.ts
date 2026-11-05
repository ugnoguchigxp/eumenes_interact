import { fileURLToPath } from "node:url";
import {
	CaptureStore as SharedCaptureStore,
	type CaptureStoreOptions,
} from "eumenes-interact/parts";
export {
	resolveCaptureDir,
	CaptureError,
	type SavedCapture,
	type CaptureRange,
	type CaptureStoreOptions,
} from "eumenes-interact/parts";
export const DEFAULT_CAPTURES_DIR = fileURLToPath(
	new URL("../../data/captures", import.meta.url),
);
export class CaptureStore extends SharedCaptureStore {
	constructor(o: CaptureStoreOptions) {
		super({ ...o, defaultRoot: o.defaultRoot ?? DEFAULT_CAPTURES_DIR });
	}
}
