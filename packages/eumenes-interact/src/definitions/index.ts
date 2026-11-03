import type { DefinitionApi } from "../contracts/definition.ts";
import {
	definitionDigest,
	definitionJsonSchema,
	parseDefinition,
	resolveDefinition,
} from "./definition.ts";
import { originAllowed } from "./origin.ts";

export {
	definitionDigest,
	definitionJsonSchema,
	originAllowed,
	parseDefinition,
	resolveDefinition,
};

export const definitionApi: DefinitionApi = {
	parseDefinition,
	resolveDefinition,
	definitionDigest,
	originAllowed,
	definitionJsonSchema,
};
