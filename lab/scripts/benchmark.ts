/** Bounded single-runner prototype workload; no API, filesystem or browser operation in the measured core. */
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
const target = process.env.LAB_BENCH_MODULE ?? "eumenes-interact";
const api = (await import(target)) as typeof import("eumenes-interact");
const budgets = {
	maxItems: 10_000,
	maxInputBytes: 1_000_000,
	coreP95Ms: 500,
	sampledRssBytes: 512 * 1024 * 1024,
	iterations: 30,
};
const rows = [];
for (const size of [100, 1000, 10_000]) {
	const body =
		"- main:\n" +
		Array.from(
			{ length: size },
			(_, i) =>
				`  - link "Entry ${i}" [ref=e${i}]:\n    - /url: https://example.org/${i}`,
		).join("\n");
	const raw = {
		body,
		url: "https://example.org/",
		title: "Synthetic links",
		truncated: false,
		missing: [],
	};
	if (Buffer.byteLength(body) > budgets.maxInputBytes)
		throw new Error("workload_exceeds_declared_scope");
	for (const kind of ["summary", "find", "list"] as const) {
		const job = () =>
			kind === "summary"
				? api.summarizePage(raw, { pageId: "p1", maxItems: 40, maxHeadings: 8 })
				: kind === "find"
					? api.findItems(body, "p1", { text: "Entry", role: "link" }, 20)
					: api.listEntries(body, "p1", "links", 40);
		for (let n = 0; n < 3; n++) job();
		const samples = [];
		let maxRss = 0;
		const cpuStart = process.cpuUsage();
		for (let n = 0; n < budgets.iterations; n++) {
			const t = performance.now();
			job();
			samples.push(performance.now() - t);
			maxRss = Math.max(maxRss, process.memoryUsage().rss);
		}
		samples.sort((a, b) => a - b);
		rows.push({
			size,
			kind,
			bytes: Buffer.byteLength(body),
			p50Ms: samples[14],
			p95Ms: samples[28],
			maxMs: samples.at(-1),
			sampledRssBytes: maxRss,
			cpuMicros: process.cpuUsage(cpuStart),
			withinBudget:
				samples[28]! <= budgets.coreP95Ms && maxRss <= budgets.sampledRssBytes,
		});
	}
}
const result = {
	at: new Date().toISOString(),
	target,
	runtime: {
		bun: Bun.version,
		node: process.version,
		os: process.platform,
		arch: process.arch,
		cpu: cpus()[0]?.model,
	},
	scope:
		"Synthetic bounded core workload; sampled RSS is not a browser/process-tree peak or a production SLO.",
	budgets,
	rows,
	resourceUsage: process.resourceUsage(),
};
writeFileSync(
	process.env.LAB_BENCH_OUT ??
		"docs/reviews/2026-11-05/implementation/benchmark-current.json",
	JSON.stringify(result, null, 2) + "\n",
);
console.log(
	JSON.stringify(
		rows.map(({ size, kind, p95Ms, sampledRssBytes, withinBudget }) => ({
			size,
			kind,
			p95Ms,
			sampledRssBytes,
			withinBudget,
		})),
	),
);
if (rows.some((r) => !r.withinBudget)) process.exitCode = 1;
