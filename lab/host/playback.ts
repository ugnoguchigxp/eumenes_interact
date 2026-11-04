/**
 * The done check of a step whose result is a playing video (2026-11-04, live S11: `done` was sent while a 60 s
 * ad played). The host, not the model, decides: a step is done only when the page's largest video shows no ad
 * and its position advances across at least two consecutive samples. While an ad plays the user is told; the
 * ad is never skipped here (a skip is a click, which needs the user's approval). Read-only: nothing is clicked.
 */

export type MediaSample =
	| { found: false }
	| {
			found: true;
			currentTime: number | null;
			duration: number | null;
			paused: boolean;
			ended: boolean;
			readyState: number;
			adShowing: boolean;
	  };

export type PlaybackVerdict =
	| { ok: true; samples: MediaSample[]; adSeen: boolean }
	| {
			ok: false;
			code: "playback_no_video" | "playback_not_advancing" | "playback_ad_too_long";
			samples: MediaSample[];
			adSeen: boolean;
	  };

export type PlaybackGateOptions = {
	sample: () => Promise<MediaSample>;
	sleep: (ms: number) => Promise<void>;
	/** Told once when an ad starts and once when the main video takes over. */
	notify: (message: string) => void;
	intervalMs?: number;
	/** Longest an ad may play before the step gives up (it is still left playing). */
	maxAdMs?: number;
	/** Longest the main video may sit without advancing. */
	maxStallMs?: number;
	/** Wall clock: a slow sample (up to its timeout) must not stretch the limits (live S11: a 180 s limit took ~5 min). */
	now?: () => number;
};

/** Advances needed between consecutive non-ad samples: two, so three samples in a row. */
export const PLAYBACK_ADVANCES = 2;

export async function confirmPlayback(
	o: PlaybackGateOptions,
): Promise<PlaybackVerdict> {
	const interval = o.intervalMs ?? 2000;
	const maxAd = o.maxAdMs ?? 180_000;
	const maxStall = o.maxStallMs ?? 20_000;
	const samples: MediaSample[] = [];
	let adSeen = false;
	const now = o.now ?? Date.now;
	let adMs = 0;
	let adStart = 0;
	let stallMs = 0;
	let inAd = false;
	let last: number | null = null;
	let advances = 0;
	for (;;) {
		let s: MediaSample;
		try {
			s = await o.sample();
		} catch {
			s = { found: false };
		}
		samples.push(s);
		if (!s.found) {
			stallMs += interval;
			last = null;
			advances = 0;
			if (stallMs > maxStall)
				return { ok: false, code: "playback_no_video", samples, adSeen };
		} else if (s.adShowing) {
			if (!inAd)
				o.notify(
					"広告を再生中です。終わるまで待ちます（スキップする場合はお知らせください。スキップのクリックには承認が必要です）。",
				);
			if (!inAd) adStart = now();
			inAd = true;
			adSeen = true;
			adMs = Math.max(adMs + interval, now() - adStart);
			last = null;
			advances = 0;
			if (adMs > maxAd)
				return { ok: false, code: "playback_ad_too_long", samples, adSeen };
		} else {
			if (inAd) o.notify("広告が終わり、本編の再生に移りました。");
			inAd = false;
			const t = s.currentTime;
			if (!s.paused && !s.ended && t !== null && last !== null && t > last)
				advances += 1;
			else {
				// The first sample of a run has nothing to compare with; anything else is a stall.
				if (last !== null || s.paused || s.ended || t === null) advances = 0;
				if (last !== null || s.paused || s.ended) stallMs += interval;
			}
			last = s.paused || s.ended ? null : t;
			if (advances >= PLAYBACK_ADVANCES)
				return { ok: true, samples, adSeen };
			if (stallMs > maxStall)
				return { ok: false, code: "playback_not_advancing", samples, adSeen };
		}
		await o.sleep(interval);
	}
}

/** A step whose result is playback (the planner's keep-open steps that play something). */
export function isPlaybackGoal(goal: string): boolean {
	return /再生|流して|play|watch|視聴/iu.test(goal);
}
