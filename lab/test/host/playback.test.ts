import { describe, expect, test } from "bun:test";
import {
	confirmPlayback,
	isPlaybackGoal,
	type MediaSample,
} from "../../host/playback.ts";

const v = (currentTime: number, extra: Partial<MediaSample> = {}): MediaSample =>
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
	test("which goals are playback", () => {
		expect(isPlaybackGoal("YouTubeでその曲を再生して")).toBe(true);
		expect(isPlaybackGoal("まとめる")).toBe(false);
	});
});

test("an ad's limit is wall-clock time, not the count of samples", async () => {
	let t = 0;
	const v = await confirmPlayback({
		sample: async () => {
			t += 7000;
			return { found: true, currentTime: 1, duration: 30, paused: false, ended: false, readyState: 4, adShowing: true };
		},
		sleep: async () => {},
		notify: () => {},
		now: () => t,
	});
	expect(v.ok).toBe(false);
	expect(v.samples.length).toBeLessThan(30);
});
