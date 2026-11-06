import type { PartsCoreApi } from "../../contracts/parts.ts";
import { partCallJsonSchema } from "./schema.ts";
import { listEntries } from "./listings.ts";
import {
	findItems,
	findText,
	formFields,
	resolveItem,
	summarizePage,
} from "./summary.ts";

export {
	findItems,
	findText,
	formFields,
	listEntries,
	partCallJsonSchema,
	resolveItem,
	summarizePage,
};

export const partsApi: PartsCoreApi = {
	summarizePage,
	resolveItem,
	findItems,
	listEntries,
	formFields,
	partCallJsonSchema,
};
