import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalPrompt } from "../../host/approval.ts";
import { StopApprover } from "../../host/approval.ts";
import {
	AllowlistApprover,
	allowedKind,
	loadAllowlist,
} from "../../host/allowlist.ts";

const prompt = (
	page: string,
	element: string,
	action: ApprovalPrompt["action"] = "click",
): ApprovalPrompt => ({
	approvalId: "a1",
	operationId: "o1",
	tabRef: "t1",
	page,
	action,
	element,
	summary: "",
});

describe("action allowlist", () => {
	const entries = loadAllowlist();
	test("the shipped file grants YouTube play/pause only", () => {
		expect(
			allowedKind(
				entries,
				prompt("https://www.youtube.com/watch", 'button "再生 (k)"'),
			),
		).toBe("media.play");
		expect(
			allowedKind(
				entries,
				prompt("https://www.youtube.com/watch", 'button "Pause (k)"'),
			),
		).toBe("media.pause");
		expect(
			allowedKind(
				entries,
				prompt(
					"https://www.youtube.com/watch",
					'button "Play keyboard shortcut k"',
				),
			),
		).toBe("media.play");
		expect(
			allowedKind(
				entries,
				prompt("https://vimeo.com/76979871", 'button "Play"'),
			),
		).toBeNull();
		expect(
			allowedKind(
				entries,
				prompt("https://www.youtube.com.evil.example/x", 'button "Play"'),
			),
		).toBeNull();
	});
	test("names beyond the fixed kind, typing and presses are not granted", () => {
		expect(
			allowedKind(
				entries,
				prompt(
					"https://www.youtube.com/watch",
					'button "Play all and subscribe"',
				),
			),
		).toBeNull();
		expect(
			allowedKind(
				entries,
				prompt("https://www.youtube.com/watch", 'button "登録"'),
			),
		).toBeNull();
		expect(
			allowedKind(
				entries,
				prompt("https://www.youtube.com/watch", 'button "Play"', "type"),
			),
		).toBeNull();
		expect(
			allowedKind(
				entries,
				prompt("https://www.youtube.com/watch", 'button "k"', "press"),
			),
		).toBeNull();
	});
	test("not listed falls back: unattended denies and keeps the prompt", async () => {
		const stop = new StopApprover();
		const lines: string[] = [];
		const a = new AllowlistApprover(entries, stop, (l) => lines.push(l));
		expect(
			await a.decide(
				prompt("https://vimeo.com/1", 'button "Play"'),
				AbortSignal.timeout(1000),
			),
		).toBe("deny");
		expect(stop.prompt?.page).toBe("https://vimeo.com/1");
		expect(
			await a.decide(
				prompt("https://www.youtube.com/watch", 'button "再生"'),
				AbortSignal.timeout(1000),
			),
		).toBe("grant");
		expect(lines.map((l) => l.split("\t")[1])).toEqual(["not_listed", "grant"]);
	});
	test("a file cannot carry patterns, unknown kinds or plain http", () => {
		const dir = mkdtempSync(join(tmpdir(), "allow-"));
		try {
			const f = join(dir, "a.json");
			writeFileSync(
				f,
				JSON.stringify({
					entries: [{ origin: "https://x.example", actions: ["click.any"] }],
				}),
			);
			expect(() => loadAllowlist(f)).toThrow(
				"allowlist_invalid:0:action:click.any",
			);
			writeFileSync(
				f,
				JSON.stringify({
					entries: [{ origin: "http://x.example", actions: ["media.play"] }],
				}),
			);
			expect(() => loadAllowlist(f)).toThrow("allowlist_invalid:0:origin");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
