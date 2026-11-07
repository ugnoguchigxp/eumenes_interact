/** Bounded core and host workloads; no API or real browser in the measured region. */
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { setupParts, call } from "../test/host/parts-harness.ts";
import { FakeBrowser } from "../test/host/fake-adapter.ts";
const target = process.env.LAB_BENCH_MODULE ?? "eumenes-interact";
const api = (await import(target)) as typeof import("eumenes-interact");
const budgets = {
	maxNodes: 10_000,
	maxInputBytes: 1_000_000,
	coreP95Ms: 500,
	hostP95Ms: 500,
	sampledRssBytes: 512 * 1024 * 1024,
	iterations: Number(process.env.LAB_BENCH_ITERATIONS ?? 30),
};
if (
	!Number.isSafeInteger(budgets.iterations) ||
	budgets.iterations < 1 ||
	budgets.iterations > 30
)
	throw new Error("invalid_benchmark_iterations");
const sizes = process.env.LAB_BENCH_SIZES?.split(",").map(Number) ?? [
	100, 1000, 10_000,
];
if (
	sizes.some((n) => !Number.isSafeInteger(n) || n < 5 || n > budgets.maxNodes)
)
	throw new Error("invalid_benchmark_size");
const kinds = [
	"summary",
	"find",
	"links",
	"results",
	"host.find",
	"host.results",
] as const;
const selected = process.env.LAB_BENCH_KINDS?.split(",") ?? kinds;
if (selected.some((k) => !kinds.includes(k as (typeof kinds)[number])))
	throw new Error("invalid_benchmark_kind");
const shapes = ["flat", "listitems", "cards"] as const;
const chosenShapes = process.env.LAB_BENCH_SHAPES?.split(",") ?? shapes;
if (chosenShapes.some((s) => !shapes.includes(s as (typeof shapes)[number])))
	throw new Error("invalid_benchmark_shape");
const rows = [];
for (const size of sizes)
	for (const shape of chosenShapes) {
		const lines = ["- main [ref=e0]:"];
		let nodes = 1;
		const stride = shape === "flat" ? 1 : shape === "listitems" ? 2 : 4;
		for (let i = 0; nodes + stride <= size; i++) {
			if (shape === "flat")
				lines.push(
					`  - link "Entry ${i}" [ref=e${nodes}]:`,
					`    - /url: https://example.org/${i}`,
				);
			else if (shape === "listitems")
				lines.push(
					`  - listitem:`,
					`    - link "Entry ${i}" [ref=e${nodes + 1}]:`,
					`      - /url: https://example.org/${i}`,
				);
			else
				lines.push(
					`  - article "Card ${i}" [ref=e${nodes}]:`,
					`    - heading "Entry ${i}"`,
					`    - link "Entry ${i}" [ref=e${nodes + 2}]:`,
					`      - /url: https://example.org/${i}`,
					`    - paragraph: Description of entry ${i}.`,
				);
			nodes += stride;
		}
		while (nodes++ < size) lines.push("  - paragraph: Padding");
		const body = lines.join("\n");
		const raw = {
			body,
			url: "https://example.org/",
			title: "Synthetic entries",
			truncated: false,
			missing: [],
		};
		if (Buffer.byteLength(body) > budgets.maxInputBytes)
			throw new Error("workload_exceeds_declared_scope");
		class WorkloadBrowser extends FakeBrowser {
			override async observe() {
				return { ...(await super.observe()), body };
			}
		}
		const host = selected.some((k) => k.startsWith("host."))
			? await setupParts({ adapter: new WorkloadBrowser() })
			: null;
		try {
			for (const kind of kinds.filter((k) => selected.includes(k))) {
				const job = async () => {
					switch (kind) {
						case "summary":
							return api.summarizePage(raw, {
								pageId: "p1",
								maxItems: 40,
								maxHeadings: 8,
							});
						case "find":
							return api.findItems(
								body,
								"p1",
								{ text: "Entry", role: "link" },
								20,
							);
						case "links":
						case "results":
							return api.listEntries(body, "p1", kind, 40);
						case "host.find":
							return host!.result(
								call("page.find", { text: null, role: "link" }),
							);
						case "host.results":
							return host!.result(
								call("page.list", { kind: "results", limit: 40 }),
							);
					}
				};
				for (let n = 0; n < (budgets.iterations === 1 ? 0 : 3); n++)
					await job();
				const samples = [];
				let maxRss = 0;
				const cpuStart = process.cpuUsage();
				for (let n = 0; n < budgets.iterations; n++) {
					const t = performance.now();
					await job();
					samples.push(performance.now() - t);
					maxRss = Math.max(maxRss, process.memoryUsage().rss);
				}
				samples.sort((a, b) => a - b);
				const row = {
					size,
					shape,
					kind,
					bytes: Buffer.byteLength(body),
					workloadSha256: createHash("sha256").update(body).digest("hex"),
					p50Ms: samples[Math.ceil(samples.length * 0.5) - 1],
					p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
					maxMs: samples.at(-1),
					sampledRssBytes: maxRss,
					cpuMicros: process.cpuUsage(cpuStart),
					withinBudget:
						samples[Math.ceil(samples.length * 0.95) - 1]! <=
							(kind.startsWith("host.")
								? budgets.hostP95Ms
								: budgets.coreP95Ms) && maxRss <= budgets.sampledRssBytes,
				};
				rows.push(row);
				console.log(JSON.stringify(row));
			}
		} finally {
			host?.cleanup();
			host?.db.close();
		}
	}
const result = {
	at: new Date().toISOString(),
	target,
	commit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
	runtime: {
		bun: Bun.version,
		node: process.version,
		os: process.platform,
		arch: process.arch,
		cpu: cpus()[0]?.model,
	},
	scope:
		"Exact node counts, three structures; core and host with FakeBrowser. Host includes observation/ledger IO, not real browser latency. Sampled RSS is not peak RSS or a production SLO.",
	budgets,
	rows,
	resourceUsage: process.resourceUsage(),
};
writeFileSync(
	process.env.LAB_BENCH_OUT ?? "lab/data/benchmark-current.json",
	JSON.stringify(result, null, 2) + "\n",
);
if (rows.some((r) => !r.withinBudget)) process.exitCode = 1;
