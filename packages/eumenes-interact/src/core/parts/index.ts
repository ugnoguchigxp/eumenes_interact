import type { PartsCoreApi } from "../../contracts/parts.ts";
import { partCallJsonSchema } from "./schema.ts";
import {
	findItems,
	formFields,
	listEntries,
	resolveItem,
	summarizePage,
} from "./summary.ts";

export {
	findItems,
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
