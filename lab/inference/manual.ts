import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { InferencePort } from "eumenes-interact";

/**
 * A file-driven inference for running a reasoner by hand (no provider, no token): each call writes the
 * messages to `<dir>/<caseId>-<n>.req.json` and waits until `<dir>/<caseId>-<n>.res.txt` appears; its text is
 * the model output. Usage is not reported (null), so tokens stay unmeasured. The directory is the caller's
 * (outside the repository). Stored as the `scripted` kind: there is no provider to record.
 */
export function createManualInference(
	dir: string,
	caseId: string,
	pollMs = 500,
): InferencePort {
	mkdirSync(dir, { recursive: true });
	let n = 0;
	return {
		async complete({ messages, signal, outputSchema }) {
			n += 1;
			const base = `${dir}/${caseId}-${n}`;
			writeFileSync(
				`${base}.req.json`,
				JSON.stringify({ messages, outputSchema }, null, 1),
			);
			const started = Date.now();
			while (!existsSync(`${base}.res.txt`)) {
				// The operator tore the work dir down (end.sh) or cancelled: do not hold the run lock for the
				// full call timeout while polling a path that will never appear (review 2026-11-05 M1).
				if (signal.aborted || !existsSync(dir))
					return {
						kind: "error",
						code: "aborted",
						usage: { inputTokens: null, outputTokens: null },
						latencyMs: Date.now() - started,
					};
				await Bun.sleep(pollMs);
			}
			const text = readFileSync(`${base}.res.txt`, "utf8").trim();
			return {
				kind: text ? "text" : "empty",
				...(text ? { text } : { code: "empty" }),
				usage: { inputTokens: null, outputTokens: null },
				latencyMs: Date.now() - started,
			} as never;
		},
	};
}
