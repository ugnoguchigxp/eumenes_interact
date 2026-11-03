import {
	AdapterError,
	COMMON_ACTIONS,
	type AdapterCommand,
	type AdapterDispatchResult,
	type AdapterState,
	type AdapterTarget,
	type CatalogEntry,
	type ExtractedContent,
	type FixedInspection,
	type InspectionResult,
	type PlatformAdapter,
	type RawObservation,
} from "eumenes-interact";

/**
 * An in-memory browser for host tests: a few fixture-like pages with ARIA snapshot text, URL transitions per
 * command, tabs. No process, no network, no port.
 */

export const BASE = "http://127.0.0.1:41234/";

export type PageDef = {
	title: string;
	/** ARIA snapshot lines, with `[ref=eN]` on the elements. */
	lines: string[];
	/** What a click on a ref does: returns the URL to go to, or opens a tab itself. */
	click?: Record<string, (b: FakeBrowser) => string | undefined>;
	/** The element a filled field with `submit` presses. */
	submitRef?: string;
	info?: Record<string, InspectionResult>;
	/** The page's main text, as `extract` returns it (default: its snapshot lines). */
	text?: string;
};

type Tab = { url: string; title: string };

const GET_SUBMIT: InspectionResult = {
	tag: "button",
	type: "submit",
	inForm: true,
	formMethod: "get",
	submits: true,
};
const PLAIN_BUTTON: InspectionResult = {
	tag: "button",
	type: "button",
	inForm: false,
	submits: false,
};
const LINK: InspectionResult = { tag: "a", inForm: false, submits: false };

/** The pages of the fake site, by path under `BASE`. */
function wiki(url: URL, b: FakeBrowser): PageDef | null {
	const at = (rest: string) => new URL(rest, url).href;
	const search: PageDef["lines"] = [
		"- banner [ref=e1]:",
		'  - searchbox "Wikipedia内を検索" [ref=e2]',
	];
	const article = "/wiki/%E6%A9%9F%E6%A2%B0%E5%AD%A6%E7%BF%92";
	if (url.pathname === "/")
		return {
			title: "Wikipedia",
			lines: [
				...search,
				"- main [ref=e3]:",
				'  - heading "Wikipedia" [level=1] [ref=e4]',
				'  - button "メニュー" [ref=e5]',
			],
			submitRef: "e2",
			click: {
				e5: () => at("/"),
				e2: () =>
					b.field("e2") === "機械学習"
						? at(article)
						: at(`/w/index.php?search=${encodeURIComponent(b.field("e2"))}`),
			},
			info: { e2: GET_SUBMIT, e5: PLAIN_BUTTON },
		};
	if (url.pathname === "/w/index.php")
		return {
			title: "検索結果 - Wikipedia",
			lines: [
				...search,
				"- main [ref=e3]:",
				'  - link "ヘルプ" [ref=e4]:',
				"    - /url: /wiki/Help:%E6%A4%9C%E7%B4%A2",
				'  - link "特別ページ" [ref=e5]:',
				"    - /url: /wiki/%E7%89%B9%E5%88%A5:%E6%A4%9C%E7%B4%A2",
				'  - link "赤リンク" [ref=e6]:',
				"    - /url: /w/index.php?title=X&action=edit&redlink=1",
				"  - link [ref=e7]:",
				`    - /url: ${article}`,
				'  - link "機械学習" [ref=e8]:',
				`    - /url: ${article}`,
				'  - link "人工知能" [ref=e9]:',
				"    - /url: /wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD",
			],
			click: {
				e8: () => at(article),
				e9: () => at("/wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD"),
			},
			info: { e4: LINK, e8: LINK, e9: LINK },
		};
	if (url.pathname.startsWith("/wiki/"))
		return {
			title: "機械学習 - Wikipedia",
			lines: [
				...search,
				"- main [ref=e3]:",
				'  - heading "機械学習" [level=1] [ref=e4]',
				"  - paragraph [ref=e5]: 機械学習は、データから学習するアルゴリズムの研究分野である。",
			],
			text: "機械学習は、データから学習するアルゴリズムの研究分野である。",
			info: { e2: GET_SUBMIT },
			submitRef: "e2",
			click: { e2: () => at("/w/index.php?search=x") },
		};
	return null;
}

function site(url: URL, b: FakeBrowser): PageDef | null {
	if (url.hostname.endsWith("wikipedia.org")) return wiki(url, b);
	const path = url.pathname.slice(1);
	// A video site in the shape of a live page: the origin is whatever the test navigates to.
	const at = (rest: string) => new URL(rest, url).href;
	switch (path) {
		case "":
			return {
				title: "YouTube",
				lines: [
					"- banner [ref=e1]:",
					'  - combobox "検索" [ref=e2]',
					'  - button "検索" [ref=e3]',
				],
				submitRef: "e3",
				click: {
					e3: () =>
						at(`/results?search_query=${encodeURIComponent(b.field("e2"))}`),
				},
				info: { e2: GET_SUBMIT, e3: GET_SUBMIT },
			};
		case "results":
			return {
				title: "AI research - YouTube",
				lines: [
					"- main [ref=e1]:",
					'  - link "AI research のしくみ 12:34" [ref=e2]:',
					"    - /url: /watch?v=abc123",
					'  - link "AI research のしくみ" [ref=e3]:',
					"    - /url: /watch?v=abc123",
					'  - link "チャンネル" [ref=e4]:',
					"    - /url: /@channel",
					'  - link "別の動画" [ref=e5]:',
					"    - /url: /watch?v=def456",
				],
				click: {
					e2: () => at("/watch?v=abc123"),
					e3: () => at("/watch?v=abc123"),
					e5: () => at("/watch?v=def456"),
				},
				info: { e2: LINK, e3: LINK, e5: LINK },
			};
		case "watch":
			return {
				title: "AI research のしくみ - YouTube",
				lines: [
					"- main [ref=e1]:",
					'  - heading "AI research のしくみ" [level=1] [ref=e2]',
					'  - button "一時停止" [ref=e3]',
				],
			};
		case "sites/hoshikuzu/base/index.html":
			return {
				title: "星屑堂書店",
				lines: [
					"- banner [ref=e1]:",
					'  - link "星屑堂書店" [ref=e2]',
					'  - navigation "メイン" [ref=e3]:',
					'    - link "ホーム" [ref=e4]',
					'    - link "ご利用案内" [ref=e5]',
					'    - button "店舗の地図" [ref=e6]',
					"  - search [ref=e7]:",
					'    - searchbox "書名・著者" [ref=e8]',
					'    - button "検索" [ref=e9]',
					"- main [ref=e10]:",
					'  - heading "星屑堂書店" [level=1] [ref=e11]',
				],
				submitRef: "e9",
				click: {
					e4: () => `${BASE}sites/hoshikuzu/base/index.html`,
					e5: () => {
						b.openTab(`${BASE}sites/hoshikuzu/base/guide.html`);
						return undefined;
					},
					e6: () => {
						b.openTab(`${BASE}sites/hoshikuzu/base/map.html`);
						return undefined;
					},
					e9: () =>
						`${BASE}sites/hoshikuzu/base/results.html?q=${encodeURIComponent(b.field("e8"))}`,
				},
				info: {
					e4: LINK,
					e5: LINK,
					e6: PLAIN_BUTTON,
					e8: GET_SUBMIT,
					e9: GET_SUBMIT,
				},
			};
		case "sites/hoshikuzu/base/results.html":
			return {
				title: "検索結果 | 星屑堂書店",
				lines: [
					"- main [ref=e1]:",
					'  - heading "検索結果" [level=1] [ref=e2]',
					"  - paragraph [ref=e3]: 「白波」: 1件",
					'  - link "月影の図書館" [ref=e4]',
				],
				click: { e4: () => `${BASE}sites/hoshikuzu/base/book.html?id=1` },
				info: { e4: LINK },
			};
		case "sites/hoshikuzu/base/guide.html":
			return {
				title: "ご利用案内 | 星屑堂書店",
				lines: [
					"- main [ref=e1]:",
					'  - heading "ご利用案内" [level=1] [ref=e2]',
				],
			};
		case "sites/hoshikuzu/base/map.html":
			return {
				title: "店舗の地図 | 星屑堂書店",
				lines: [
					"- main [ref=e1]:",
					'  - heading "店舗の地図" [level=1] [ref=e2]',
				],
			};
		case "sites/minato-hall/base/index.html":
			return {
				title: "みなと市民ホール",
				lines: [
					'- navigation "メイン" [ref=e1]:',
					'  - link "ホーム" [ref=e2]',
					'  - link "見学の申し込み" [ref=e3]',
					'  - link "メールマガジン" [ref=e4]',
				],
				click: {
					e3: () => `${BASE}sites/minato-hall/base/apply.html`,
					e4: () => `${BASE}sites/minato-hall/base/mail.html`,
				},
				info: { e3: LINK, e4: LINK },
			};
		case "sites/minato-hall/base/apply.html": {
			const dates: Record<string, string> = {
				"11月14日（土）": "2026-11-14",
				"11月21日（土）": "2026-11-21",
				"11月28日（土）": "2026-11-28",
			};
			return {
				title: "ホール見学の申し込み | みなと市民ホール",
				lines: [
					"- main [ref=e1]:",
					'  - heading "ホール見学の申し込み" [level=1] [ref=e2]',
					'  - textbox "お名前" [required] [ref=e3]',
					'  - textbox "メールアドレス" [required] [ref=e4]',
					'  - combobox "見学希望日" [ref=e5]',
					'  - combobox "人数" [ref=e6]',
					'  - button "申し込む" [ref=e7]',
				],
				click: {
					e7: () => {
						const query = new URLSearchParams({
							fullname: b.field("e3"),
							email: b.field("e4"),
							date: dates[b.field("e5")] ?? "",
							people: b.field("e6").replace("名", ""),
						});
						return `${BASE}sites/minato-hall/base/done.html?${query}`;
					},
				},
				info: { e7: GET_SUBMIT },
			};
		}
		case "sites/minato-hall/base/done.html":
			return {
				title: "見学の申し込み完了 | みなと市民ホール",
				lines: [
					"- main [ref=e1]:",
					'  - heading "見学の申し込み完了" [level=1] [ref=e2]',
				],
			};
		case "sites/minato-hall/base/mail.html":
			return {
				title: "メールマガジン | みなと市民ホール",
				lines: [
					"- main [ref=e1]:",
					'  - heading "メールマガジン" [level=1] [ref=e2]',
					'  - button "配信を停止する" [ref=e3]',
				],
				click: {
					e3: () =>
						`${BASE}sites/minato-hall/base/unsubscribed.html?list=events`,
				},
				info: { e3: GET_SUBMIT },
			};
		case "sites/minato-hall/base/unsubscribed.html":
			return {
				title: "配信停止完了 | みなと市民ホール",
				lines: [
					"- main [ref=e1]:",
					'  - heading "配信停止完了" [level=1] [ref=e2]',
				],
			};
		default:
			return null;
	}
}

/**
 * A Playwright-shaped snapshot in Agent Browser's: one bracket of attributes with the ref (and a link's
 * destination) inline, no `- /url:` child lines, no paragraph text.
 */
export function toAgentBrowser(body: string): string {
	const out: string[] = [];
	for (const line of body.split("\n")) {
		const dest = /^\s*- \/url:\s*(.*)$/.exec(line);
		if (dest) {
			const last = out.pop();
			if (last) out.push(last.replace(/\]$/, `, url=${dest[1]}]`));
			continue;
		}
		const m =
			/^(\s*- [A-Za-z][\w-]*(?: "(?:[^"\\]|\\.)*")?)((?: \[[^\]]*\])*)(?::.*)?$/.exec(
				line,
			);
		if (!m) continue;
		const attrs = [...(m[2] ?? "").matchAll(/\[([^\]]*)\]/g)].map((a) => a[1]!);
		const ref = attrs.find((a) => a.startsWith("ref="));
		const rest = attrs.filter((a) => !a.startsWith("ref="));
		const all = [...rest, ...(ref ? [ref] : [])];
		out.push(`${m[1]}${all.length ? ` [${all.join(", ")}]` : ""}`);
	}
	return out.join("\n");
}

export type FakeOptions = {
	platform?: "playwright-mcp" | "agent-browser";
	/** The shape of the snapshot the browser returns. */
	format?: "playwright" | "agent-browser";
	/** Agent Browser cannot read an element's facts: `inspect` then rejects as unsupported. */
	inspectSupported?: boolean;
};

export class FakeBrowser implements PlatformAdapter {
	readonly platform: "playwright-mcp" | "agent-browser";
	private readonly format: "playwright" | "agent-browser";

	constructor(options: FakeOptions = {}) {
		this.platform = options.platform ?? "playwright-mcp";
		this.format = options.format ?? "playwright";
		this.inspectSupported = options.inspectSupported ?? true;
	}

	private readonly inspectSupported: boolean;

	private status: AdapterState = "closed";
	private tabs: Tab[] = [];
	private current = 0;
	private fields = new Map<string, string>();
	/** Every adapter call in order, for assertions. */
	readonly calls: string[] = [];
	readonly dispatched: AdapterCommand[] = [];
	closeCount = 0;
	/** Test hooks. */
	failOpen = false;
	/** Runs when the session opens; an error it returns rejects the open (a cancel can happen here). */
	onOpen: (() => Error | undefined) | null = null;
	observeError: Error | null = null;
	/** Runs inside `dispatch`, after the call is recorded; may return a result to use instead. */
	onDispatch:
		| ((
				command: AdapterCommand,
				b: FakeBrowser,
		  ) => AdapterDispatchResult | undefined)
		| null = null;
	/** The page's URL changes to this the next time the browser is looked at (a redirect after the action returned). */
	settleTo: string | null = null;
	/** URL a fresh `newTarget` or `openTab` lands on, to simulate a page leaving the scope. */
	nextTabUrl: string | null = null;

	toolInfo() {
		return {
			name:
				this.platform === "agent-browser"
					? "fake-agent-browser"
					: "fake-playwright",
			version: "0.0.0",
		};
	}

	catalog(): readonly CatalogEntry[] {
		return COMMON_ACTIONS.map((action) => ({
			action,
			platform: "playwright-mcp",
			supported: action !== "page.scroll" && action !== "page.capture",
			needsTargetRef: false,
			physicalInput: false,
		}));
	}

	open(): Promise<void> {
		this.calls.push("open");
		const opening = this.onOpen?.();
		if (opening) return Promise.reject(opening);
		if (this.failOpen)
			return Promise.reject(new AdapterError("mcp_unavailable", false));
		this.status = "open";
		this.tabs = [{ url: "about:blank", title: "" }];
		this.current = 0;
		return Promise.resolve();
	}

	close(): Promise<void> {
		this.closeCount++;
		this.status = "closed";
		return Promise.resolve();
	}

	state(): AdapterState {
		return this.status;
	}

	field(ref: string): string {
		return this.fields.get(ref) ?? "";
	}

	private page(): PageDef | null {
		const tab = this.tabs[this.current];
		return tab ? site(new URL(tab.url), this) : null;
	}

	private targets(): AdapterTarget[] {
		return this.tabs.map((t, i) => ({
			targetRef: String(i),
			kind: "tab",
			current: i === this.current,
			url: t.url,
			title: t.title,
		}));
	}

	goto(url: string) {
		const tab = this.tabs[this.current]!;
		tab.url = url;
		this.fields = new Map();
		tab.title = site(new URL(url), this)?.title ?? "";
	}

	/** A new tab becomes the current one, as in the browser. */
	openTab(url: string) {
		const landed = this.nextTabUrl ?? url;
		this.nextTabUrl = null;
		this.tabs.push({
			url: landed,
			title: site(new URL(landed), this)?.title ?? "",
		});
		this.current = this.tabs.length - 1;
	}

	get url(): string {
		return this.tabs[this.current]?.url ?? "";
	}

	private applySettle() {
		if (this.settleTo === null) return;
		const tab = this.tabs[this.current]!;
		tab.url = this.settleTo;
		this.settleTo = null;
	}

	/** Moves another tab's page behind the host's back. */
	setTabUrl(index: number, url: string) {
		this.tabs[index]!.url = url;
	}

	listTargets(): Promise<AdapterTarget[]> {
		this.calls.push("listTargets");
		this.applySettle();
		return Promise.resolve(this.targets());
	}

	selectTarget(targetRef: string): Promise<AdapterTarget[]> {
		this.calls.push(`selectTarget:${targetRef}`);
		this.current = Number(targetRef);
		return Promise.resolve(this.targets());
	}

	newTarget(url: string): Promise<AdapterTarget[]> {
		this.calls.push("newTarget");
		this.openTab(url);
		return Promise.resolve(this.targets());
	}

	observe(): Promise<RawObservation> {
		this.calls.push("observe");
		this.applySettle();
		if (this.observeError) return Promise.reject(this.observeError);
		const tab = this.tabs[this.current]!;
		const page = this.page();
		return Promise.resolve({
			body:
				this.format === "agent-browser"
					? toAgentBrowser(page ? page.lines.join("\n") : "- generic [ref=e1]")
					: page
						? page.lines.join("\n")
						: "- generic [ref=e1]",
			url: tab.url,
			title: tab.title,
			truncated: false,
			missing: [],
		});
	}

	dispatch(command: AdapterCommand): Promise<AdapterDispatchResult> {
		this.calls.push(`dispatch:${command.action}`);
		this.dispatched.push(command);
		const override = this.onDispatch?.(command, this);
		if (override) return Promise.resolve(override);
		const page = this.page();
		let failed: string | null = null;
		switch (command.action) {
			case "browser.navigate":
				this.goto(command.url);
				break;
			case "page.fill":
				this.fields.set(command.targetRef, command.text);
				if (command.submit && page?.submitRef) {
					const target = page.click?.[page.submitRef]?.(this);
					if (target) this.goto(target);
				}
				break;
			case "page.click": {
				const handler = page?.click?.[command.targetRef];
				if (!handler) failed = "stale_ref";
				else {
					const target = handler(this);
					if (target) this.goto(target);
				}
				break;
			}
			case "page.select":
				this.fields.set(command.targetRef, command.values[0] ?? "");
				break;
			default:
				break;
		}
		if (failed)
			return Promise.resolve({
				status: "failed",
				code: failed,
				retryable: false,
			});
		const tab = this.tabs[this.current]!;
		return Promise.resolve({
			status: "confirmed",
			retryable: false,
			url: tab.url,
			title: tab.title,
		});
	}

	/** Test hook: `extract` fails with this error. */
	extractError: Error | null = null;
	readonly extracted: { targetRef: string | null; maxChars: number }[] = [];

	extract(
		targetRef: string | null,
		maxChars: number,
	): Promise<ExtractedContent> {
		this.calls.push("extract");
		this.extracted.push({ targetRef, maxChars });
		if (this.extractError) return Promise.reject(this.extractError);
		const tab = this.tabs[this.current]!;
		const text = this.page()?.text ?? this.page()?.lines.join("\n") ?? "";
		return Promise.resolve({
			url: tab.url,
			title: tab.title,
			text: text.slice(0, maxChars),
			charCount: text.length,
			truncated: text.length > maxChars,
			root: targetRef ? "target" : "main",
		});
	}

	inspect(
		_kind: FixedInspection,
		targetRef: string | null,
	): Promise<InspectionResult> {
		this.calls.push("inspect");
		if (!this.inspectSupported)
			return Promise.reject(new AdapterError("unsupported", false));
		const info = targetRef ? this.page()?.info?.[targetRef] : undefined;
		return Promise.resolve(info ?? PLAIN_BUTTON);
	}
}
