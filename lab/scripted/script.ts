import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ARM0_TOOL_IDS } from "eumenes-interact";

/**
 * A scripted run (plan.md §15 S1): per dev case a file of steps. A step names an Arm 0 tool and describes its
 * target by role and accessible name, never by ref; the refs of the current observation are looked up when
 * the step runs. A holdout case has no script.
 */

const ancestor = z.strictObject({
	role: z.string().min(1),
	name: z.string().min(1).optional(),
});

/** An element as the page names it; `within` narrows to elements below such ancestors. */
export const targetSchema = z.strictObject({
	role: z.string().min(1),
	name: z.string().min(1),
	within: z.array(ancestor).optional(),
});
export type Target = z.infer<typeof targetSchema>;

const invokeStep = z.strictObject({
	tool: z.enum(ARM0_TOOL_IDS),
	/** For tools that act on an element. */
	target: targetSchema.optional(),
	/** For `tab_select`: a tab whose title contains this text. */
	tab: z.strictObject({ title: z.string().min(1) }).optional(),
	/** The tool's other arguments; refs, element and observationRef are filled in. */
	args: z.record(z.string(), z.unknown()).optional(),
});
const stepSchema = z.union([
	invokeStep,
	z.strictObject({ finish: z.string().min(1) }),
	z.strictObject({ clarify: z.string().min(1) }),
]);
export type ScriptStep = z.infer<typeof stepSchema>;

export const scriptSchema = z.strictObject({
	caseId: z.string().min(1),
	steps: z.array(stepSchema).min(1),
});
export type Script = z.infer<typeof scriptSchema>;

export const SCRIPTS_DIR = fileURLToPath(new URL("./scripts", import.meta.url));

export const scriptPath = (caseId: string) => `${SCRIPTS_DIR}/${caseId}.json`;

/** The script of a case; a case without one (every holdout case) is an error, not a silent skip. */
export async function loadScript(caseId: string): Promise<Script> {
	let text: string;
	try {
		text = await readFile(scriptPath(caseId), "utf8");
	} catch {
		throw new Error(`no_script:${caseId}`);
	}
	const script = scriptSchema.parse(JSON.parse(text));
	if (script.caseId !== caseId)
		throw new Error(`script_case_mismatch:${caseId}`);
	return script;
}
