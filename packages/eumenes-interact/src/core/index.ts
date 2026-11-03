import type { CoreApi } from "../contracts/core.ts";
import {
	applyResult,
	parseCoreState,
	parseStep,
	prepareStep,
	shapeObservation,
	startRun,
} from "./arm0/run.ts";

export { ARM0_TOOL_IDS } from "./arm0/tools.ts";
export { ARM0_SOURCE_COMMIT } from "./arm0/source.ts";
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
