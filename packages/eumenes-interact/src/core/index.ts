import type { CoreApi } from "../contracts/core.ts";
import {
	applyResult,
	parseCoreState,
	parseStep,
	prepareStep,
	shapeObservation,
	startRun,
} from "./dispatch.ts";

export { partsApi } from "./parts/index.ts";
export {
	findItems,
	findText,
	formFields,
	listEntries,
	partCallJsonSchema,
	resolveItem,
	summarizePage,
} from "./parts/index.ts";
export {
	applyResult,
	parseCoreState,
	parseStep,
	prepareStep,
	shapeObservation,
	startRun,
};

export const coreApi: CoreApi = {
	startRun,
	prepareStep,
	parseStep,
	applyResult,
	shapeObservation,
	parseCoreState,
};
