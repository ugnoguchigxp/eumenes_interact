import type {
	CapturedImage,
	ExtractedContent,
	HostCall,
	HostOutcome,
	InspectionResult,
} from "../../index.ts";
import type { RunEndStatus } from "../errors.ts";
export type Executed =
	| { kind: "outcome"; outcome: HostOutcome }
	| { kind: "end"; status: RunEndStatus; code: string };
/** Trusted host options, never part of the model's call schema. */
export type ExecuteOptions = { valueChecked?: boolean; recoverable?: boolean };
export type PartExecutionPort = {
	execute(call: HostCall, options?: ExecuteOptions): Promise<Executed>;
	attach(): Promise<string>;
	extract(
		tabRef: string,
		observationRef: string | undefined,
		targetRef: string | null,
		maxChars: number,
	): Promise<ExtractedContent>;
	capture(
		tabRef: string,
		observationRef: string | undefined,
		range: "viewport" | "full" | "item",
		targetRef: string | null,
	): Promise<CapturedImage>;
	sortOptions?(tabRef: string): Promise<InspectionResult>;
};
type Tab = { tabRef: string; status: "open" | "lost" | "blocked" };
export type PartTabPort = {
	get(tabRef: string): Tab | undefined;
	open(): Tab[];
};
