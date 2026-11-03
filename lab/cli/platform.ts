/**
 * The platforms a lab command can drive (plan.md §10.3). Playwright MCP is the mainstream (plan.md §12.1);
 * Agent Browser was tried and not adopted. The choice stays, as one value, so a later arm (Playwright
 * direct) has a place to be named.
 */
export const BROWSER_PLATFORMS = ["playwright-mcp"] as const;
export type BrowserPlatform = (typeof BROWSER_PLATFORMS)[number];

export const DEFAULT_PLATFORM: BrowserPlatform = "playwright-mcp";

/** A platform that was evaluated and left out: said so, not reported as a typo. */
const NOT_ADOPTED = ["agent-browser"];

export function parsePlatform(value: string | undefined): BrowserPlatform {
	if (value === undefined) return DEFAULT_PLATFORM;
	if ((BROWSER_PLATFORMS as readonly string[]).includes(value))
		return value as BrowserPlatform;
	if (NOT_ADOPTED.includes(value))
		throw new Error(
			`platform_not_adopted:${value} (only ${BROWSER_PLATFORMS.join(", ")} is supported)`,
		);
	throw new Error(
		`invalid_platform:${value} (only ${BROWSER_PLATFORMS.join(", ")} is supported)`,
	);
}
