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

/**
 * While a browser is kept open on a playing video, what changed between two read-only samples that the
 * user should hear about: an ad starting (mid-roll) or ending, or the video ending. Ads are only reported;
 * skipping one is a click that needs the user's approval.
 */
export function keptMediaNotice(
	prev: MediaSample | null,
	next: MediaSample,
): string | null {
	if (!next.found) return null;
	const wasAd = prev?.found === true && prev.adShowing;
	if (next.adShowing && !wasAd)
		return "動画の途中で広告が始まりました（スキップする場合はお知らせください。スキップのクリックには承認が必要です）。";
	if (!next.adShowing && wasAd) return "広告が終わり、本編の再生に戻りました。";
	if (next.ended && !(prev?.found === true && prev.ended))
		return "動画が最後まで再生されました。";
	return null;
}

/** A wall-clock time in the user's zone (JST, UTC+9, no DST), e.g. `2026-11-04T22:15:03+09:00`, so probe lines need no conversion before they are shown. */
export function jstIso(at: Date): string {
	const shifted = new Date(at.getTime() + 9 * 3600_000);
	return `${shifted.toISOString().slice(0, 19)}+09:00`;
}

/**
 * One probe of a kept tab: reads the media (read-only), prints a `media` line in JST and, when the sample
 * crosses an ad start/end or the end, a `notice` line. Returns the sample to compare against next time
 * (the previous one when the read failed, so a failed read never invents a transition).
 */
export async function probeKeptMedia(
	read: () => Promise<MediaSample>,
	prev: MediaSample | null,
	log: (line: string) => void,
	now: () => Date = () => new Date(),
): Promise<MediaSample | null> {
	try {
		const m = await read();
		log(`media\t${jstIso(now())}\t${JSON.stringify(m)}`);
		const notice = keptMediaNotice(prev, m);
		if (notice) log(`notice\t${notice}`);
		return m;
	} catch (error) {
		log(`media\t${jstIso(now())}\tunread:${String(error)}`);
		return prev;
	}
}
