// `bun run check:dist` (plan.md §12): the built dist loads under Node through the package exports,
// and the core's pure functions run there. Plain JavaScript so Node needs no TypeScript support.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const root = await import("eumenes-interact");
const sqlite = await import("eumenes-interact/sqlite");
const playwright = await import("eumenes-interact/adapters/playwright-mcp");
const pkg = createRequire(import.meta.url)("eumenes-interact/package.json");

assert.equal(typeof root.startRun, "function");
const state = root.startRun({
	arm: "arm0",
	request: "検索欄に「白波」と入力して検索してください",
	policy: { maxModelCalls: 4, retries: { default: 1 } },
	nowMs: Date.UTC(2026, 10, 3, 3, 0, 0),
});
const prepared = root.prepareStep(state);
assert.ok(prepared.messages.length >= 3);
assert.equal(
	root.parseCoreState(JSON.parse(JSON.stringify(state)))?.arm,
	"arm0",
);
const shaped = root.shapeObservation("arm0", {
	body: '- button "検索" [ref=e1]',
	truncated: false,
	missing: [],
});
assert.ok(shaped.refCount >= 0);

assert.ok(Array.isArray(sqlite.migrations) && sqlite.migrations.length > 0);
assert.equal(typeof sqlite.createRun, "function");
assert.equal(typeof playwright.createPlaywrightMcpAdapter, "function");
assert.ok(!playwright.ALLOWED_MCP_TOOLS.includes("browser_run_code_unsafe"));

console.log(
	`check:dist ok (node ${process.version}, ${pkg.name}@${pkg.version}, ${prepared.messages.length} messages)`,
);
