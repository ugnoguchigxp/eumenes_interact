import { z } from "zod";
import {
	workDefinitionSchema,
	type DefinitionIssue,
	type ResolvedStep,
	type WorkDefinition,
} from "../contracts/definition.ts";
import { canonicalJson } from "./canonical.ts";
import {
	checkHttpsUrl,
	originAllowed,
	originText,
	parsePattern,
} from "./origin.ts";
import { sha256Hex } from "./sha256.ts";

/**
 * Issues carry a fixed code and a path, never a value: not a definition's literals and, above all, not an
 * input the caller gave (plan.md §6, §14).
 */

const MAX_ISSUES = 32;
const OPTIONAL_ACTIONS = ["page.fill", "page.click", "page.extract"];
const NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/;

const isInputRef = (value: unknown): value is { $input: string } =>
	typeof value === "object" && value !== null && "$input" in value;

/** The navigate URL's problem, as an issue code, or null when it is an https URL inside the allowed origins. */
function urlProblem(url: string, allowedOrigins: readonly string[]) {
	const checked = checkHttpsUrl(url);
	if (!checked.ok) return checked.code;
	return originAllowed(allowedOrigins, originText(checked.origin))
		? null
		: "url_origin_not_allowed";
}

export function parseDefinition(
	value: unknown,
):
	| { ok: true; definition: WorkDefinition }
	| { ok: false; issues: DefinitionIssue[] } {
	const parsed = workDefinitionSchema.safeParse(value);
	if (!parsed.success)
		return {
			ok: false,
			issues: parsed.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
				path: issue.path.map(String).join("."),
				code: `schema_${issue.code}`,
			})),
		};
	const d = parsed.data;
	const issues: DefinitionIssue[] = [];
	const add = (path: string, code: string) => issues.push({ path, code });
	const properties = d.inputs.properties;

	for (const [i, pattern] of d.allowedOrigins.entries()) {
		const origin = parsePattern(pattern);
		if (!origin) add(`allowedOrigins.${i}`, "origin_invalid");
		else if (origin.wildcard && origin.port !== 443)
			add(`allowedOrigins.${i}`, "wildcard_with_port");
	}
	for (const [i, name] of d.inputs.required.entries())
		if (!Object.hasOwn(properties, name))
			add(`inputs.required.${i}`, "required_not_declared");
	for (const [name, property] of Object.entries(properties))
		if (
			property.minLength !== undefined &&
			property.maxLength !== undefined &&
			property.minLength > property.maxLength
		)
			add(`inputs.properties.${name}`, "length_range");

	const ids = new Set<string>();
	for (const [i, step] of d.steps.entries()) {
		const at = `steps.${i}`;
		if (ids.has(step.id)) add(`${at}.id`, "duplicate_step_id");
		ids.add(step.id);
		if ("args" in step)
			for (const [key, arg] of Object.entries(step.args))
				if (isInputRef(arg) && !Object.hasOwn(properties, arg.$input))
					add(`${at}.args.${key}`, "undeclared_input");
		if (
			step.action === "browser.navigate" &&
			typeof step.args.url === "string"
		) {
			const problem = urlProblem(step.args.url, d.allowedOrigins);
			if (problem) add(`${at}.args.url`, problem);
		}
		if (step.optional) {
			if (!OPTIONAL_ACTIONS.includes(step.action))
				add(`${at}.optional`, "optional_action_not_allowed");
			else if (!("targetObject" in step) || step.targetObject === undefined)
				add(`${at}.optional`, "optional_without_target");
		}
	}
	if (d.steps[0]!.action !== "browser.navigate")
		add("steps.0.action", "first_step_not_navigate");
	return issues.length
		? { ok: false, issues: issues.slice(0, MAX_ISSUES) }
		: { ok: true, definition: d };
}

/** Control characters other than tab: no input carries a newline or an escape into a page or a log. */
function hasControl(text: string) {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f))
			return true;
	}
	return false;
}

export function resolveDefinition(
	definition: WorkDefinition,
	inputs: Readonly<Record<string, unknown>>,
):
	| { ok: true; steps: ResolvedStep[] }
	| { ok: false; issues: DefinitionIssue[] } {
	const issues: DefinitionIssue[] = [];
	const add = (path: string, code: string) => issues.push({ path, code });
	const properties = definition.inputs.properties;
	const values = new Map<string, string>();

	for (const key of Object.keys(inputs))
		if (!Object.hasOwn(properties, key))
			// A key that does not look like a declared name is not echoed.
			add(`inputs.${NAME.test(key) ? key : "?"}`, "unknown_input");
	for (const name of definition.inputs.required)
		if (!Object.hasOwn(inputs, name) || inputs[name] === undefined)
			add(`inputs.${name}`, "missing_input");
	for (const [name, property] of Object.entries(properties)) {
		const given = Object.hasOwn(inputs, name) ? inputs[name] : undefined;
		if (given === undefined) continue;
		if (typeof given !== "string") {
			add(`inputs.${name}`, "not_string");
			continue;
		}
		const text = given.normalize("NFC");
		const length = [...text].length;
		if (hasControl(text)) add(`inputs.${name}`, "control_character");
		else if (property.minLength !== undefined && length < property.minLength)
			add(`inputs.${name}`, "too_short");
		else if (property.maxLength !== undefined && length > property.maxLength)
			add(`inputs.${name}`, "too_long");
		else values.set(name, text);
	}

	const steps: ResolvedStep[] = [];
	for (const [i, step] of definition.steps.entries()) {
		if (!("args" in step)) {
			steps.push(step as ResolvedStep);
			continue;
		}
		const args: Record<string, unknown> = {};
		for (const [key, arg] of Object.entries(step.args)) {
			if (!isInputRef(arg)) {
				args[key] = arg;
				continue;
			}
			const resolved = values.get(arg.$input);
			if (resolved !== undefined) args[key] = resolved;
			else if (!Object.hasOwn(properties, arg.$input))
				add(`steps.${i}.args.${key}`, "undeclared_input");
		}
		if (step.action === "browser.navigate" && typeof args.url === "string") {
			const problem = urlProblem(args.url, definition.allowedOrigins);
			if (problem) add(`steps.${i}.args.url`, problem);
		}
		steps.push({ ...step, args } as ResolvedStep);
	}
	return issues.length
		? { ok: false, issues: issues.slice(0, MAX_ISSUES) }
		: { ok: true, steps };
}

export const definitionDigest = (definition: WorkDefinition): string =>
	sha256Hex(canonicalJson(definition));

export const definitionJsonSchema = (): Record<string, unknown> =>
	z.toJSONSchema(workDefinitionSchema) as Record<string, unknown>;
