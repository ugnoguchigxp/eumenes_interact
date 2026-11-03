import type {
	AdapterCommand,
	DeclaredEffect,
	InspectionResult,
} from "eumenes-interact";

/**
 * Which operations need the user's approval before they are sent. Ported from Eumenes (commit 98b188d2):
 * `approvals.ts` (`keyCommits`, `needsApproval`, `needsButtonClickApproval`), `operation-plan.ts` (which
 * click, key and type operations carry a commit guard and whether the model's own declaration is enough) and
 * `operations.ts` `commitNeeded` (the decision itself). The element facts come from the adapter's fixed
 * inspection; the model's declared effect alone can only add an approval, never remove one.
 */

export type ApprovalAction = "click" | "press" | "type";

/** What decides the approval: the declaration, or what a fixed inspection reads from the element. */
export type CommitGuard = {
	action: ApprovalAction;
	declared: boolean;
	probe: { ref: string } | "focused";
};

/** Keys that press the focused element's default action: Enter submits a form, Space presses a button. */
const COMMIT_KEYS = new Set(["enter", "numpadenter", "space"]);
export const keyCommits = (key: string) =>
	COMMIT_KEYS.has((key.split("+").at(-1) ?? "").toLowerCase());

/**
 * Whether what the element would do needs approval (spec §5.3): it submits a form whose method is not GET.
 * A form without a method is a GET form, and `dialog` forms only close a dialog. A form the page did not
 * describe is treated as a non-GET form.
 */
export const needsApproval = (info: InspectionResult) =>
	info.inForm === true &&
	info.submits === true &&
	info.formMethod !== "get" &&
	info.formMethod !== "dialog";

/** A click on `button` or `[role=button]` whose effect the form rules do not decide. No site is exempt. */
export const needsButtonClickApproval = (info: InspectionResult) =>
	(info.tag === "button" || info.role === "button") && info.submits !== true;

/** The guard of an operation, or null when it can never need approval. */
export function commitGuard(
	command: AdapterCommand,
	declaredEffect: DeclaredEffect,
): CommitGuard | null {
	const declared = declaredEffect === "submit";
	switch (command.action) {
		case "page.click":
			return { action: "click", declared, probe: { ref: command.targetRef } };
		case "page.fill":
			return command.submit || declared
				? { action: "type", declared, probe: { ref: command.targetRef } }
				: null;
		case "page.press":
			return declared || keyCommits(command.key)
				? { action: "press", declared, probe: "focused" }
				: null;
		default:
			return null;
	}
}

/**
 * The platform cannot read the element's facts (Agent Browser has no tool that runs a function on a ref).
 * What an operation would do is then not limited, so it needs approval (plan.md §9: an effect that cannot
 * be limited waits for the user), except where the snapshot alone settles it: see `LINK_FACTS`.
 */
export const UNJUDGEABLE = "unjudgeable" as const;
export type Inspected = InspectionResult | typeof UNJUDGEABLE | null;

/** What the inspection reads of an `<a>`: it submits no form, so a link click is judged as in Eumenes. */
export const LINK_FACTS: InspectionResult = {
	tag: "a",
	inForm: false,
	submits: false,
};

/** The decision, given what the inspection read (only asked when the guard is not already declared). */
export const approvalNeeded = (guard: CommitGuard, info: Inspected) =>
	guard.declared ||
	info === UNJUDGEABLE ||
	(info !== null &&
		(needsApproval(info) ||
			(guard.action === "click" && needsButtonClickApproval(info))));
