import { z } from "zod";
import { taskStateSchema } from "./task.ts";

/**
 * What Arm 0 keeps between steps besides the task core's own state: Eumenes' `Work` (the tab the page tools act
 * on, its origin, what pages showed, the refs the model may cite) plus what the host-side checks of Eumenes
 * (`assertActionable`) read from its database: the latest observation of each tab.
 */
const workSchema = z.strictObject({
	/** The tab the page tools act on; null until one is selected. */
	tabRef: z.string().nullable(),
	/** The origin that tab was last seen at: what an input value is bound to (the URL itself is not kept). */
	origin: z.string().nullable(),
	/** Tool ids offered this run. */
	tools: z.array(z.string()),
	/** Whether `type` was offered with `inputValueRef` (the host passed approved input values). */
	grants: z.boolean(),
	/** What pages showed this task (normalised, bounded): a typed value that comes from it needs the user's allowance. */
	seen: z.array(z.string()).max(6),
	/** Observation refs the model may cite as evidence. */
	evidence: z.array(z.string()).max(64),
	/** The latest observation of each tab: the only one whose refs are actionable. */
	latest: z.record(
		z.string(),
		z.strictObject({ observationRef: z.string(), refs: z.array(z.string()) }),
	),
	/** The tool the host is executing: set by a valid call, read by the result. */
	pending: z
		.strictObject({ tool: z.string(), tabRef: z.string().optional() })
		.nullable(),
});
export type Work = z.infer<typeof workSchema>;

const arm0StateSchema = z.strictObject({
	formatVersion: z.literal(1),
	arm: z.literal("arm0"),
	task: taskStateSchema,
	work: workSchema,
	/** The run has finished, failed or stopped: no further step is valid. */
	ended: z.boolean(),
});
export type Arm0State = z.infer<typeof arm0StateSchema>;

/** A state read back from storage; null when it is not one this core wrote. */
export function parseArm0State(value: unknown): Arm0State | null {
	const parsed = arm0StateSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
