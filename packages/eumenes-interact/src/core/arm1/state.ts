import { z } from "zod";

const known = z.strictObject({
	/** The latest page id a result showed. */
	page: z.string().nullable(),
	/** Item ids of that page the AI has seen: the only ones it may name. */
	items: z.array(z.string()).max(500),
	/** Those of `items` that are content blocks: they can be read or captured, not opened. */
	blocks: z.array(z.string()).max(500),
	/** Result ids the AI has seen: the only ones `done` may cite. */
	results: z.array(z.string()).max(64),
});

const arm1StateSchema = z
	.strictObject({
		formatVersion: z.literal(1),
		arm: z.literal("arm1"),
		policy: z.strictObject({
			maxModelCalls: z.number().int().min(1).max(12),
			retries: z.record(z.string(), z.number().int().min(0).max(3)),
		}),
		/** The parts offered this run (`done` and `ask` always are). */
		parts: z.array(z.string()),
		/** Model calls made so far, repairs included. */
		callsMade: z.number().int().min(0),
		/** The last output was rejected once; a valid call resets it (one repair per output). */
		repaired: z.boolean(),
		/** Refusals of the host per part against its retries. */
		refusals: z.record(z.string(), z.number().int().min(0)),
		/** The raw output of a valid part call whose result has not been applied yet. */
		pendingRaw: z.string().nullable(),
		pending: z.strictObject({ part: z.string() }).nullable(),
		/** The conversation so far; its start never changes and later calls only append. */
		messages: z
			.array(
				z.strictObject({
					role: z.enum(["system", "user", "assistant"]),
					content: z.string(),
				}),
			)
			.min(3),
		known,
		/** The run has finished, failed or stopped: no further step is valid. */
		ended: z.boolean(),
	})
	.refine((s) => s.callsMade <= s.policy.maxModelCalls, "callsMade");
export type Arm1State = z.infer<typeof arm1StateSchema>;

/** A state read back from storage; null when it is not one this core wrote. */
export function parseArm1State(value: unknown): Arm1State | null {
	const parsed = arm1StateSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
