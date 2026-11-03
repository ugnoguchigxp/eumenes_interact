import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import type {
	InteractEventName,
	InteractLogFields,
	LoggerPort,
} from "eumenes-interact";

/**
 * Logs (plan.md §14): pino JSONL with a correlation id, a fixed event name, a fixed code, counts and
 * durations only. Never observation text, input values, URLs or provider output: the fields type has no
 * room for them.
 */

export const DEFAULT_LOG_DIR = fileURLToPath(
	new URL("../data/logs", import.meta.url),
);

export type LabEventName =
	| "trial.started"
	| "trial.finished"
	| "run.status"
	| "run.cancelled"
	| "model.called"
	| "step.parsed"
	| "operation.dispatched"
	| "operation.settled"
	| "approval.requested"
	| "approval.answered"
	| "reconcile.run"
	| "definition.started"
	| "definition.step"
	| "definition.finished"
	| "tab.navigation_followed";

export interface LabLogger extends LoggerPort {
	lab(name: LabEventName, fields: InteractLogFields): void;
	close(): void;
}

/** Drops everything (tests). */
export const silentLabLogger: LabLogger = {
	event() {},
	lab() {},
	close() {},
};

/** One JSONL file per day under `dir`; the package's events and the lab's go to the same stream. */
export function createPinoLogger(
	dir: string = DEFAULT_LOG_DIR,
	day: string = new Date().toISOString().slice(0, 10),
): LabLogger {
	const destination = pino.destination({
		dest: join(dir, `lab-${day}.jsonl`),
		mkdir: true,
		sync: true,
	});
	const logger = pino(
		{
			base: null,
			timestamp: pino.stdTimeFunctions.isoTime,
			formatters: { level: (label) => ({ level: label }) },
		},
		destination,
	);
	const emit = (
		event: InteractEventName | LabEventName,
		f: InteractLogFields,
	) =>
		logger.info({
			event,
			correlationId: f.correlationId,
			...(f.code === undefined ? {} : { code: f.code }),
			...(f.count === undefined ? {} : { count: f.count }),
			...(f.durationMs === undefined ? {} : { durationMs: f.durationMs }),
		});
	return {
		event: emit,
		lab: emit,
		close() {
			destination.flushSync();
			destination.end();
		},
	};
}
