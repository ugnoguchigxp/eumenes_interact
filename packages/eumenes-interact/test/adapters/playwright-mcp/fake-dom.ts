/**
 * A tiny DOM stand-in for running the fixed extraction function without a browser: only the
 * members that function reads (node types, tag names, child/parent links, attributes, text content,
 * layout presence, computed display and `querySelectorAll` for tag and `[role="x"]` lists).
 */
export class FakeText {
	readonly nodeType = 3;
	parentNode: FakeEl | null = null;
	constructor(readonly textContent: string) {}
}

export class FakeEl {
	readonly nodeType = 1;
	parentNode: FakeEl | null = null;
	childNodes: (FakeEl | FakeText)[] = [];
	constructor(
		readonly tagName: string,
		private attrs: Record<string, string>,
		children: (FakeEl | string)[],
		readonly display = "block",
	) {
		for (const child of children) {
			const node = typeof child === "string" ? new FakeText(child) : child;
			node.parentNode = this;
			this.childNodes.push(node);
		}
	}
	getAttribute(name: string) {
		return name in this.attrs ? (this.attrs[name] ?? "") : null;
	}
	get textContent(): string {
		return this.childNodes.map((c) => c.textContent).join("");
	}
	/** Empty when this element or an ancestor has no box (display:none). */
	getClientRects(): object[] {
		if (this.display === "none") return [];
		return this.parentNode ? this.parentNode.getClientRects() : [{}];
	}
	descendants(): FakeEl[] {
		return this.childNodes.flatMap((c) =>
			c instanceof FakeEl ? [c, ...c.descendants()] : [],
		);
	}
}

export const h = (
	tag: string,
	attrs: Record<string, string> = {},
	...children: (FakeEl | string)[]
) => new FakeEl(tag, attrs, children);
/** An element with a computed display other than block. */
export const hd = (
	tag: string,
	display: string,
	...children: (FakeEl | string)[]
) => new FakeEl(tag, {}, children, display);

/** A document whose `html > body` holds `children`. */
export function fakeDocument(
	children: (FakeEl | string)[],
	title = "Page title",
	href = "https://a.test/post",
) {
	const body = h("BODY", {}, ...children);
	const html = h("HTML", {}, body);
	const matches = (el: FakeEl, selector: string) =>
		selector.split(",").some((part) => {
			const s = part.trim();
			const role = /^\[role="([^"]+)"\]$/.exec(s);
			return role
				? el.getAttribute("role") === role[1]
				: el.tagName.toLowerCase() === s;
		});
	const document = {
		body,
		title,
		querySelectorAll: (selector: string) =>
			html.descendants().filter((el) => matches(el, selector)),
	};
	return { document, location: { href }, body };
}

type Extracted = {
	url: string;
	title: string;
	text: string;
	charCount: number;
	root: string;
};

/** Evaluates a function source against the fake page, as `browser_evaluate` would. */
export function runExtraction(
	source: string,
	page: ReturnType<typeof fakeDocument>,
	element?: FakeEl,
): Extracted {
	const fn = new Function(
		"document",
		"getComputedStyle",
		"location",
		`return (${source})`,
	)(page.document, (n: FakeEl) => ({ display: n.display }), page.location);
	return fn(element);
}
