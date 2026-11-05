import {
	findItems,
	formFields,
	listEntries,
	resolveItem,
	summarizePage,
	type PartsCoreApi,
} from "../../index.ts";

/**
 * The pure helpers of the package's parts layer (plan.md §6.4), gathered in one place so the part executor
 * takes them as a value: a test may pass its own, and a rename in the package is a change to this file only.
 */
export type PartsHelpers = Omit<PartsCoreApi, "partCallJsonSchema">;

export const partsHelpers: PartsHelpers = {
	summarizePage,
	resolveItem,
	findItems,
	listEntries,
	formFields,
};
