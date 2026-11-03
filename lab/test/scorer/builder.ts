import type { AdapterCommand, DeclaredEffect } from "eumenes-interact";
import { loadCases } from "../../cases/load.ts";
import type { CaptureRange, CaseDef } from "../../cases/schema.ts";
import type {
	FinalKind,
	ModelCallOutcome,
	TokenUsage,
	TranscriptEvent,
	TrialTranscript,
} from "../../scorer/transcript.ts";

/** The loopback base the host serves the fixtures on (the port is arbitrary). */
export const BASE_URL = "http://127.0.0.1:43210/";
export const fixtureUrl = (path: string): string => BASE_URL + path;

export async function devCase(id: string): Promise<CaseDef> {
	const found = (await loadCases({ includeHoldout: false })).find(
		(c) => c.id === id,
	);
	if (!found) throw new Error(`no dev case ${id}`);
	return found;
}

type OperationOptions = {
	effect?: DeclaredEffect;
	requiresApproval?: boolean;
	retryOf?: string;
};

type ResultOptions = {
	status?: "confirmed" | "failed" | "indeterminate";
	code?: string;
	url?: string;
	adopted?: boolean;
};

/** Builds a synthetic transcript, one event at a time, with increasing timestamps. */
export class TranscriptBuilder {
	readonly events: TranscriptEvent[] = [];
	private clock = 0;

	private tick(): number {
		this.clock += 10;
		return this.clock;
	}

	call(
		tokens: TokenUsage = { input: 100, output: 20 },
		outcome: ModelCallOutcome = "ok",
	): this {
		this.events.push({
			type: "model.call",
			at: this.tick(),
			durationMs: 5,
			outcome,
			tokens,
		});
		return this;
	}

	parse(accepted: boolean): this {
		this.events.push({ type: "step.parse", at: this.tick(), accepted });
		return this;
	}

	observe(url: string): this {
		this.events.push({
			type: "observation",
			at: this.tick(),
			observationRef: `obs-${this.events.length}`,
			url,
			title: null,
			refCount: 3,
		});
		return this;
	}

	request(
		operationId: string,
		command: AdapterCommand,
		options: OperationOptions = {},
	): this {
		this.events.push({
			type: "operation.requested",
			at: this.tick(),
			operationId,
			command,
			declaredEffect: options.effect ?? "navigation",
			requiresApproval: options.requiresApproval ?? false,
			...(options.retryOf === undefined ? {} : { retryOf: options.retryOf }),
		});
		return this;
	}

	approval(operationId: string, decision: "grant" | "deny" | null): this {
		const approvalId = `approval-${operationId}`;
		this.events.push({
			type: "approval.requested",
			at: this.tick(),
			approvalId,
			operationId,
		});
		if (decision !== null) {
			this.events.push({
				type: "approval.answered",
				at: this.tick(),
				approvalId,
				decision,
			});
		}
		return this;
	}

	dispatch(operationId: string): this {
		this.events.push({
			type: "operation.dispatched",
			at: this.tick(),
			operationId,
		});
		return this;
	}

	result(operationId: string, options: ResultOptions = {}): this {
		this.events.push({
			type: "operation.result",
			at: this.tick(),
			operationId,
			status: options.status ?? "confirmed",
			adopted: options.adopted ?? true,
			...(options.code === undefined ? {} : { code: options.code }),
			...(options.url === undefined ? {} : { url: options.url }),
		});
		return this;
	}

	/** Request, dispatch and a confirmed result that ends on `url`. */
	step(
		operationId: string,
		command: AdapterCommand,
		url: string,
		options: OperationOptions = {},
	): this {
		return this.request(operationId, command, options)
			.dispatch(operationId)
			.result(operationId, { url });
	}

	capture(options: {
		fileName: string;
		width?: number;
		height?: number;
		range?: CaptureRange;
		mediaType?: "image/png" | "image/jpeg";
		target?: { role: string; nameHash: string };
	}): this {
		this.events.push({
			type: "capture.saved",
			at: this.tick(),
			captureId: `cap-${this.events.length}`,
			fileName: options.fileName,
			width: options.width ?? 800,
			height: options.height ?? 600,
			bytes: 1000,
			mediaType: options.mediaType ?? "image/png",
			range: options.range ?? "viewport",
			...(options.target ? { target: options.target } : {}),
		});
		return this;
	}

	cancel(): this {
		this.events.push({
			type: "run.cancelled",
			at: this.tick(),
			reason: "cancel",
		});
		return this;
	}

	final(kind: FinalKind, text?: string): this {
		this.events.push({
			type: "step.final",
			at: this.tick(),
			kind,
			...(text === undefined ? {} : { text }),
		});
		return this;
	}

	build(
		caseId: string,
		trialId = "trial-1",
		captureDir?: string,
	): TrialTranscript {
		return {
			trialId,
			caseId,
			arm: "arm0",
			fixtureBaseUrl: BASE_URL,
			startedAt: "2026-11-03T00:00:00.000Z",
			timings: { adapterOpenMs: null, totalMs: this.clock },
			...(captureDir === undefined ? {} : { captureDir }),
			events: this.events,
		};
	}
}

export const click = (targetRef: string): AdapterCommand => ({
	action: "page.click",
	targetRef,
	element: "element",
});
