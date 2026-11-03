import { AdapterError } from "../../contracts/adapter.ts";
import { textOf, type McpToolResult } from "../mcp/common.ts";

/**
 * Running a fixed function on the element of a ref. No tool of Agent Browser runs a function on an
 * element, so the element is found again by geometry: `get_box @ref` gives its box, and one fixed
 * script finds the element at a point inside that box, walks up to the first element whose own
 * rectangle equals the box, and runs the fixed function on it. The only inputs of the script are
 * numbers the adapter has validated as finite.
 *
 * ASSUMPTION (not verified against the real tool): `get_box` reports the same rectangle as
 * `getBoundingClientRect()`, i.e. viewport coordinates. If it reports page coordinates (or anything
 * else), the rectangle will not match and the script answers `match:false`: the check fails safe,
 * it can never hand back a different element. A covered element (an overlay at the probe point)
 * fails the same way. Nothing is scrolled: a probe point outside the viewport is `match:false` too.
 */

export type Box = { x: number; y: number; width: number; height: number };

/** A script the adapter built itself from fixed text and validated numbers: the only kind `eval` may run. */
declare const fixed: unique symbol;
export type FixedScript = string & { readonly [fixed]: true };

export const fixedScript = (source: string) => source as FixedScript;

/** Larger magnitudes are not boxes of a page. */
const LIMIT = 1e7;

/**
 * The box `get_box` returned (`{data:{x,y,width,height}}` or the four fields alone), or
 * `unsupported` when it is not a usable box: the element cannot be found again from it.
 */
export function parseBox(raw: McpToolResult): Box {
	const unusable = () => new AdapterError("unsupported", false);
	let value: unknown;
	try {
		value = JSON.parse(textOf(raw));
	} catch {
		throw unusable();
	}
	if (typeof value !== "object" || value === null) throw unusable();
	const record = value as Record<string, unknown>;
	const data = record.data;
	const source = (
		typeof data === "object" && data !== null ? data : record
	) as Record<string, unknown>;
	const { x, y, width, height } = source;
	for (const n of [x, y, width, height])
		if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > LIMIT)
			throw unusable();
	if ((width as number) <= 0 || (height as number) <= 0) throw unusable();
	return {
		x: x as number,
		y: y as number,
		width: width as number,
		height: height as number,
	};
}

/** A point inside the box (at most 8px from its corner, so a large element is probed at its start). */
export function probePoint(box: Box) {
	return {
		x: box.x + Math.min(box.width / 2, 8),
		y: box.y + Math.min(box.height / 2, 8),
	};
}

/**
 * The fixed locate script around a fixed function source (`(el) => {...}`). It answers
 * `{match:false}` when the probe point is outside the viewport or no element on the way up from
 * the point has the box's rectangle (within 1px on every edge); otherwise `{match:true,value}` with
 * the function's result.
 */
export function locateScript(body: string, box: Box): FixedScript {
	const point = probePoint(box);
	return fixedScript(`JSON.stringify((() => {
  const box = ${JSON.stringify(box)};
  const px = ${JSON.stringify(point.x)};
  const py = ${JSON.stringify(point.y)};
  const run = ${body};
  if (!(px >= 0 && py >= 0 && px < window.innerWidth && py < window.innerHeight)) return { match: false };
  const near = (a, b) => Math.abs(a - b) <= 1;
  for (let el = document.elementFromPoint(px, py); el; el = el.parentElement) {
    const r = el.getBoundingClientRect();
    if (near(r.left, box.x) && near(r.top, box.y) && near(r.right, box.x + box.width) && near(r.bottom, box.y + box.height))
      return { match: true, value: run(el) };
  }
  return { match: false };
})())`);
}

/** The located function's result, or `undefined` when the element could not be found again. */
export function parseLocated(result: string | undefined): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(result ?? "");
	} catch {
		throw new AdapterError("mcp_response_unrecognized", false);
	}
	if (typeof value !== "object" || value === null)
		throw new AdapterError("mcp_response_unrecognized", false);
	const { match, value: found } = value as {
		match?: unknown;
		value?: unknown;
	};
	if (match === false) return undefined;
	if (match !== true || found === undefined)
		throw new AdapterError("mcp_response_unrecognized", false);
	return JSON.stringify(found);
}
