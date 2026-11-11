import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as core from "eumenes-interact";
import { decodeLlmJson, LlmJsonError } from "eumenes-interact/llm-json";
import * as sqlite from "eumenes-interact/sqlite";
import * as adapter from "eumenes-interact/adapters/playwright-mcp";
import {
	assertChoiceQuoted,
	assertValueQuoted,
	createPartExecutor,
	effectOf,
	isPrivateAddress,
	isPrivateHost,
} from "eumenes-interact/parts";
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("eumenes-interact/package.json"));
const manifest = JSON.parse(
	readFileSync(join(root, "distribution-manifest.json"), "utf8"),
);
const hash = (b) => createHash("sha256").update(b).digest("hex");
function verify() {
	for (const [file, digest] of Object.entries(manifest.files))
		assert.equal(
			hash(readFileSync(join(root, file))),
			digest,
			`tampered:${file}`,
		);
}
verify();
assert.equal(typeof core.startRun, "function");
assert.equal(typeof sqlite.createRun, "function");
assert.equal(typeof adapter.createPlaywrightMcpAdapter, "function");
const start = () =>
	core.startRun({
		arm: "arm1",
		request: "Read the guide.",
		policy: { maxModelCalls: 3, retries: { default: 0 } },
		reference: {},
		nowMs: 0,
	});
const repairable = "{part:'page.back',args:{},}";
assert.deepEqual(decodeLlmJson(repairable), {
	value: { part: "page.back", args: {} },
	repaired: true,
});
assert.equal(core.parseStep(start(), repairable).step.kind, "call");
const incomplete = '{"part":"page.back","args":{}';
assert.throws(
	() => decodeLlmJson(incomplete),
	(error) =>
		error instanceof LlmJsonError && error.code === "llm_json_incomplete",
);
const rejected = core.parseStep(start(), incomplete);
assert.equal(rejected.record.rejection, "unparsable_json");
assert.equal(rejected.step.kind, "continue");
// Exercise the structural SQLite contract with the actual runtime's database.
const connection = process.versions.bun
	? new (await import("bun:sqlite")).Database(":memory:")
	: new (await import("node:sqlite")).DatabaseSync(":memory:");
let writing = false;
const db = {
	exec: (s) => connection.exec(s),
	query: (s) =>
		process.versions.bun ? connection.query(s) : connection.prepare(s),
	get inTransaction() {
		return writing;
	},
};
db.exec("PRAGMA foreign_keys=ON");
for (const sql of sqlite.migrations) db.exec(sql);
function transaction(fn) {
	db.exec("BEGIN");
	writing = true;
	try {
		const value = fn();
		db.exec("COMMIT");
		return value;
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	} finally {
		writing = false;
	}
}
const run = {
	runId: "consumer-run",
	skillRef: "parts@1",
	skillDigest: "d",
	catalogRef: "c",
	catalogDigest: "d",
	platform: "playwright-mcp",
	coreFormatVersion: 1,
	policy: { maxModelCalls: 3, retries: { default: 0 } },
	nowIso: new Date().toISOString(),
};
transaction(() => sqlite.createRun(db, "consumer", run));
assert.equal(sqlite.getRun(db, "consumer", run.runId).status, "queued");
assert.equal(sqlite.getRun(db, "other", run.runId), null);
assert.throws(
	() =>
		transaction(() => {
			sqlite.createRun(db, "consumer", { ...run, runId: "rolled-back" });
			throw new Error("rollback");
		}),
	/rollback/,
);
assert.equal(sqlite.getRun(db, "consumer", "rolled-back"), null);
connection.close();
const observation = {
	observationRef: "o1",
	platform: "playwright-mcp",
	sessionId: "s1",
	target: { kind: "tab", tabRef: "t1" },
	generation: 1,
	capturedAt: new Date().toISOString(),
	url: "https://fixture.example/",
	title: "Fixture",
	body: '- main:\n  - link "Guide" [ref=e1]:\n    - /url: https://fixture.example/guide\n  - button "Send" [ref=e2]',
	truncated: false,
	truncationReasons: [],
	refCount: 2,
	missing: [],
};
const records = [];
let sent = 0;
const parts = createPartExecutor({
	executor: {
		attach: async () => "t1",
		execute: async (call) => {
			if (call.kind === "observe")
				return {
					kind: "outcome",
					outcome: { kind: "observation", observation },
				};
			sent++;
			return {
				kind: "outcome",
				outcome: {
					kind: "stop",
					code: "approval_required",
					text: "Host requires approval",
				},
			};
		},
		extract: async () => ({
			text: "Public fixture",
			charCount: 14,
			truncated: false,
			root: "main",
		}),
		capture: async () => {
			throw new Error("not requested");
		},
	},
	tabs: {
		get: () => ({ tabRef: "t1", status: "open" }),
		open: () => [{ tabRef: "t1", status: "open" }],
	},
	recorder: {
		partCall: (...v) => records.push(["call", ...v]),
		partResult: (...v) => records.push(["result", ...v]),
		captureSaved: () => {},
	},
	events: { event: () => {} },
	knowledge: { resolve: () => null },
	captures: {
		save: async () => {
			throw new Error("not requested");
		},
	},
	grants: { find: () => null },
	request: "Read the guide; ask before sending.",
});
const listed = await parts.run({
	part: "page.list",
	args: { kind: "links", limit: 10 },
});
assert.equal(listed.outcome.result.status, "completed");
assert.equal(listed.outcome.result.list.entries[0].title, "Guide");
const missing = await parts.run({
	part: "page.find",
	args: { text: "not-present", role: null },
});
assert.equal(missing.outcome.result.status, "failed");
const buttons = await parts.run({
	part: "page.find",
	args: { text: "Send", role: "button" },
});
const button = buttons.outcome.result.candidates[0].item;
const stopped = await parts.run({ part: "item.open", args: { item: button } });
assert.equal(stopped.outcome.kind, "stop");
assert.equal(stopped.outcome.code, "approval_required");
assert.equal(sent, 1);
assert.ok(records.some((r) => r[0] === "result" && r[2] === "completed"));
// The shipped host vectors (design R08): the package's own functions decide every row as listed. URLs go
// through the navigation rules a host composes from them (scheme, credentials, private host; no DNS).
const vectors = JSON.parse(
	readFileSync(join(root, "dist/conformance/host-vectors.json"), "utf8"),
);
assert.ok(readFileSync(join(root, "dist/HOST-CONTRACT.md"), "utf8").length > 0);
const passes = (check) => {
	try {
		check();
		return true;
	} catch {
		return false;
	}
};
const navigable = (raw) => {
	let url;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.href === "about:blank") return true;
	return (
		(url.protocol === "http:" || url.protocol === "https:") &&
		!url.username &&
		!url.password &&
		!isPrivateHost(url.hostname)
	);
};
for (const v of vectors.urls) assert.equal(navigable(v.url), v.allow, v.url);
for (const v of vectors.addresses)
	assert.equal(isPrivateAddress(v.address), v.private, v.address);
for (const v of vectors.values)
	assert.equal(
		passes(() => assertValueQuoted(v.value, v.quote, v.request)),
		v.accept,
		v.value,
	);
for (const v of vectors.choices)
	assert.equal(
		passes(() => assertChoiceQuoted(v.label, v.quote, v.request)),
		v.accept,
		v.label,
	);
for (const v of vectors.effects)
	assert.equal(effectOf(v, v.inspection), v.effect, `${v.role} ${v.url ?? ""}`);
// The actual installed artifact must fail its own integrity check after one byte changes.
const target = join(root, "dist/skills/browse.md");
const old = readFileSync(target);
writeFileSync(target, Buffer.concat([old, Buffer.from("\nchanged")]));
assert.throws(verify, /tampered:/);
writeFileSync(target, old);
verify();
console.log(
	JSON.stringify({
		runtime: process.versions.bun
			? `bun ${process.versions.bun}`
			: `node ${process.version}`,
		package: manifest.version,
		filesVerified: Object.keys(manifest.files).length,
		normal: true,
		refusal: true,
		approval: true,
		tamperDetected: true,
		sqlite: true,
		conformance: true,
	}),
);
