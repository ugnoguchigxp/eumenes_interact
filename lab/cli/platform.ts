import type { PlatformId } from "eumenes-interact";

/** The platforms a lab command can drive (plan.md §10.3). Agent Desktop is an OS platform and is not one of them. */
export const BROWSER_PLATFORMS = ["playwright-mcp", "agent-browser"] as const;
export type BrowserPlatform = (typeof BROWSER_PLATFORMS)[number] & PlatformId;

export const DEFAULT_PLATFORM: BrowserPlatform = "playwright-mcp";

export function parsePlatform(value: string | undefined): BrowserPlatform {
	if (value === undefined) return DEFAULT_PLATFORM;
	if ((BROWSER_PLATFORMS as readonly string[]).includes(value))
		return value as BrowserPlatform;
	throw new Error(
		`invalid_platform:${value} (one of ${BROWSER_PLATFORMS.join(", ")})`,
	);
}

/**
 * `--browser` and `--executable-path` are options of `@playwright/mcp`. Agent Browser starts its own isolated
 * Chrome, so they are refused for it rather than silently ignored (a run on another browser than the one
 * asked for would be a different measurement).
 */
export function assertBrowserOptions(
	platform: BrowserPlatform,
	options: {
		browser?: string | undefined;
		executablePath?: string | undefined;
	},
): void {
	if (
		platform === "agent-browser" &&
		(options.browser !== undefined || options.executablePath !== undefined)
	)
		throw new Error(
			"browser_options_are_playwright_only: --browser and --executable-path apply to --platform playwright-mcp",
		);
}
