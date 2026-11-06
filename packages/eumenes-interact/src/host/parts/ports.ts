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
export type ExecuteOptions = {
	valueChecked?: boolean;
	recoverable?: boolean;
	/** What a granted value is for; a host passes it to `InputGrants.use` (design R19). */
	grantPurpose?: string;
};
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
	/**
	 * The host's fixed, read-only inspection of one observed element (`inspectTarget`). Optional: `item.open` uses
	 * it only to learn whether an `<a>` the snapshot gave no `/url` has an `href` (design R18). Without it, such an
	 * item asks for approval.
	 */
	inspectTarget?(
		tabRef: string,
		observationRef: string | undefined,
		targetRef: string,
	): Promise<InspectionResult>;
};
type Tab = { tabRef: string; status: "open" | "lost" | "blocked" };
export type PartTabPort = {
	get(tabRef: string): Tab | undefined;
	open(): Tab[];
};
