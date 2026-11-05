import { describe, expect, test } from "bun:test";
import {
	confirmPlayback,
	keptMediaNotice,
	jstIso,
	probeKeptMedia,
	type MediaSample,
} from "../../host/playback.ts";

const v = (
	currentTime: number,
	extra: Partial<MediaSample> = {},
): MediaSample =>
	({
		found: true,
		currentTime,
		duration: 100,
		paused: false,
		ended: false,
		readyState: 4,
		adShowing: false,
		...extra,
	}) as MediaSample;

function run(seq: MediaSample[]) {
	let i = 0;
	const notes: string[] = [];
	return confirmPlayback({
		sample: async () => seq[Math.min(i++, seq.length - 1)]!,
		sleep: async () => {},
		notify: (m) => notes.push(m),
		intervalMs: 1000,
		maxAdMs: 5000,
		maxStallMs: 3000,
	}).then((r) => ({ ...r, notes, read: i }));
}

describe("playback done check", () => {
	test("two advances of the main video confirm it", async () => {
		const r = await run([v(1), v(2), v(3)]);
		expect(r.ok).toBe(true);
		expect(r.read).toBe(3);
		expect(r.notes).toEqual([]);
	});
	test("an advancing ad is not the video: wait, tell the user, then confirm the main video", async () => {
		const ad = (t: number) => v(t, { adShowing: true });
		const r = await run([ad(1), ad(2), ad(3), v(0.5), v(1.5), v(2.5)]);
		expect(r.ok).toBe(true);
		expect(r.adSeen).toBe(true);
		expect(r.read).toBe(6);
		expect(r.notes).toHaveLength(2);
		expect(r.notes[0]).toContain("広告");
		expect(r.notes[0]).toContain("承認");
	});
	test("one advance is not enough", async () => {
		const r = await run([v(1), v(2), v(2), v(2), v(2), v(2), v(2)]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("playback_not_advancing");
	});
	test("a paused video is not playing", async () => {
		const r = await run([v(5, { paused: true })]);
		expect(r.ok).toBe(false);
	});
	test("an ad that never ends gives up (and nothing is skipped)", async () => {
		const r = await run([v(1, { adShowing: true })]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("playback_ad_too_long");
	});
	test("no video", async () => {
		const r = await run([{ found: false }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("playback_no_video");
	});
});

test("an ad's limit is wall-clock time, not the count of samples", async () => {
	let t = 0;
	const v = await confirmPlayback({
		sample: async () => {
			t += 7000;
			return {
				found: true,
				currentTime: 1,
				duration: 30,
				paused: false,
				ended: false,
				readyState: 4,
				adShowing: true,
			};
		},
		sleep: async () => {},
		notify: () => {},
		now: () => t,
	});
	expect(v.ok).toBe(false);
	expect(v.samples.length).toBeLessThan(30);
});

describe("while kept open", () => {
	const s = (adShowing: boolean, ended = false) =>
		({
			found: true,
			currentTime: 10,
			duration: 100,
			paused: false,
			ended,
			readyState: 4,
			adShowing,
		}) as const;
	test("a mid-roll ad start and its end are told once each, and the video's end", () => {
		expect(keptMediaNotice(s(false), s(true))).toContain("広告が始まりました");
		expect(keptMediaNotice(s(true), s(true))).toBeNull();
		expect(keptMediaNotice(s(true), s(false))).toContain(
			"本編の再生に戻りました",
		);
		expect(keptMediaNotice(s(false), s(false))).toBeNull();
		expect(keptMediaNotice(s(false), s(false, true))).toContain("最後まで");
		expect(keptMediaNotice(null, { found: false })).toBeNull();
	});
});

describe("kept-tab probe (chain-command)", () => {
	const at = () => new Date("2026-11-04T13:15:03.456Z");
	const sample = (adShowing: boolean): MediaSample => ({
		found: true,
		currentTime: 10,
		duration: 100,
		paused: false,
		ended: false,
		readyState: 4,
		adShowing,
	});

	test("times are shown in JST", () => {
		expect(jstIso(at())).toBe("2026-11-04T22:15:03+09:00");
		expect(jstIso(new Date("2026-12-31T20:00:00Z"))).toBe(
			"2027-01-01T05:00:00+09:00",
		);
	});

	test("an ad starting prints a media line and a notice, and the sample becomes prev", async () => {
		const lines: string[] = [];
		const next = await probeKeptMedia(
			async () => sample(true),
			sample(false),
			(l) => lines.push(l),
			at,
		);
		expect(lines[0]).toStartWith("media\t2026-11-04T22:15:03+09:00\t{");
		expect(lines[1]).toContain("広告が始まりました");
		expect(next).toEqual(sample(true));
	});

	test("a failed read prints unread and keeps the previous sample, so no transition is invented", async () => {
		const lines: string[] = [];
		const prev = sample(true);
		const next = await probeKeptMedia(
			async () => {
				throw new Error("closed");
			},
			prev,
			(l) => lines.push(l),
			at,
		);
		expect(lines).toEqual([
			"media\t2026-11-04T22:15:03+09:00\tunread:Error: closed",
		]);
		expect(next).toBe(prev);
	});

	test("no change prints only the media line", async () => {
		const lines: string[] = [];
		await probeKeptMedia(
			async () => sample(false),
			sample(false),
			(l) => lines.push(l),
			at,
		);
		expect(lines).toHaveLength(1);
	});
});
