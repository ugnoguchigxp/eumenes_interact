import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { WorkDefinition } from "../../src/contracts/definition.ts";
import {
	definitionApi,
	definitionDigest,
	definitionJsonSchema,
	originAllowed,
	parseDefinition,
	resolveDefinition,
} from "../../src/definitions/index.ts";
import { canonicalJson } from "../../src/definitions/canonical.ts";
import { sha256Hex } from "../../src/definitions/sha256.ts";

const valid = (): Record<string, unknown> => ({
	formatVersion: 1,
	id: "wikipedia-search",
	revision: 1,
	title: "Wikipedia で調べる",
	skillRef: "skill:interact.execute@1",
	catalogRef: "catalog:wikipedia@1",
	allowedOrigins: ["https://*.wikipedia.org"],
	inputs: {
		type: "object",
		properties: {
			keyword: { type: "string", minLength: 1, maxLength: 20 },
		},
		required: ["keyword"],
		additionalProperties: false,
	},
	steps: [
		{
			id: "open",
			action: "browser.navigate",
			expectation: "トップページが開く",
			args: { url: "https://ja.wikipedia.org/" },
		},
		{
			id: "search",
			action: "page.fill",
			targetObject: "site.search_box",
			expectation: "検索語が入る",
			args: { value: { $input: "keyword" }, submit: true },
		},
		{
			id: "pick",
			action: "page.click",
			targetObject: "results.first",
			optional: true,
			expectation: "記事が開く",
		},
		{
			id: "read",
			action: "page.extract",
			targetObject: "article.body",
			expectation: "本文が取れる",
			args: { maxChars: 4000 },
		},
	],
});

/** A copy of the valid definition changed by `edit`. */
const changed = (edit: (d: any) => void) => {
	const d = valid();
	edit(d);
	return d;
};
const codes = (value: unknown) => {
	const parsed = parseDefinition(value);
	return parsed.ok ? [] : parsed.issues.map((i) => `${i.path}:${i.code}`);
};
const definition = () => {
	const parsed = parseDefinition(valid());
	if (!parsed.ok) throw new Error("the sample must be valid");
	return parsed.definition;
};

describe("parseDefinition", () => {
	test("accepts a valid definition", () => {
		const parsed = parseDefinition(valid());
		expect(parsed.ok).toBe(true);
	});

	test("schema violations get a fixed code and a path", () => {
		expect(codes({})).toContain("formatVersion:schema_invalid_value");
		expect(codes(changed((d) => (d.extra = 1)))).toEqual([
			":schema_unrecognized_keys",
		]);
		expect(codes(changed((d) => (d.steps[1].args.submit = "yes")))).toEqual([
			"steps.1.args.submit:schema_invalid_type",
		]);
		expect(codes(changed((d) => (d.steps[0].action = "page.rm")))).toEqual([
			"steps.0.action:schema_invalid_union",
		]);
	});

	test("step ids are unique", () => {
		expect(codes(changed((d) => (d.steps[1].id = "open")))).toEqual([
			"steps.1.id:duplicate_step_id",
		]);
	});

	test("every $input names a declared property", () => {
		expect(
			codes(changed((d) => (d.steps[1].args.value = { $input: "word" }))),
		).toEqual(["steps.1.args.value:undeclared_input"]);
	});

	test("required is a subset of properties", () => {
		expect(codes(changed((d) => d.inputs.required.push("other")))).toEqual([
			"inputs.required.1:required_not_declared",
		]);
	});

	test("minLength is not above maxLength", () => {
		expect(
			codes(changed((d) => (d.inputs.properties.keyword.minLength = 21))),
		).toEqual(["inputs.properties.keyword:length_range"]);
	});

	describe("a literal navigate url", () => {
		const url = (u: string) => codes(changed((d) => (d.steps[0].args.url = u)));
		test("must be https", () => {
			expect(url("http://ja.wikipedia.org/")).toEqual([
				"steps.0.args.url:url_not_https",
			]);
			expect(url("javascript://ja.wikipedia.org/%0Aalert(1)")).toEqual([
				"steps.0.args.url:url_not_https",
			]);
			expect(url("ja.wikipedia.org")).toEqual(["steps.0.args.url:url_invalid"]);
		});
		test("has no userinfo", () => {
			expect(url("https://user:pw@ja.wikipedia.org/")).toEqual([
				"steps.0.args.url:url_userinfo",
			]);
			expect(url("https://ja.wikipedia.org@evil.example.com/")).toEqual([
				"steps.0.args.url:url_userinfo",
			]);
		});
		test("has its origin in allowedOrigins", () => {
			expect(url("https://evil.example.com/")).toEqual([
				"steps.0.args.url:url_origin_not_allowed",
			]);
			expect(url("https://ja.wikipedia.org.evil.com/")).toEqual([
				"steps.0.args.url:url_origin_not_allowed",
			]);
			expect(url("https://ja.wikipedia.org:8443/")).toEqual([
				"steps.0.args.url:url_origin_not_allowed",
			]);
		});
		test("is read with the scheme and host lowercased and the default port dropped", () => {
			expect(url("HTTPS://JA.Wikipedia.ORG:443/wiki/A?x=1#f")).toEqual([]);
		});
		test("hosts a browser could read differently are refused", () => {
			for (const u of [
				"https://ja.wikipedia.org\\@evil.com/",
				"https://ja.wikipedia.org./",
				"https://[::1]/",
				"https://ja.wikipedia.org:/",
				"https://ja.wikipedia.org:99999/",
				"https://ja%2Ewikipedia.org/",
				"https://日本.wikipedia.org/",
			])
				expect(url(u)).toHaveLength(1);
		});
	});

	test("an allowed wildcard origin with a port is refused", () => {
		expect(
			codes(
				changed((d) => (d.allowedOrigins = ["https://*.wikipedia.org:8443"])),
			),
		).toContain("allowedOrigins.0:wildcard_with_port");
	});

	describe("optional steps", () => {
		test("need a targetObject, and only fill, click and extract may be optional", () => {
			expect(
				codes(changed((d) => (d.steps[3] = { ...d.steps[3], optional: true }))),
			).toEqual([]);
			expect(
				codes(
					changed((d) => {
						delete d.steps[3].targetObject;
						d.steps[3].optional = true;
					}),
				),
			).toEqual(["steps.3.optional:optional_without_target"]);
			expect(
				codes(
					changed((d) =>
						d.steps.push({
							id: "wait",
							action: "page.wait",
							optional: true,
							expectation: "待つ",
							args: { seconds: 1 },
						}),
					),
				),
			).toEqual(["steps.4.optional:optional_action_not_allowed"]);
		});
	});

	test("the first step should be browser.navigate", () => {
		expect(codes(changed((d) => d.steps.shift()))).toEqual([
			"steps.0.action:first_step_not_navigate",
		]);
	});

	test("issues never echo a literal of the definition", () => {
		const text = JSON.stringify(
			codes(
				changed((d) => {
					d.steps[0].args.url = "https://secret-host.example.net/token";
					d.title = "x".repeat(500);
				}),
			),
		);
		expect(text).not.toContain("secret-host");
		expect(text).not.toContain("xxxx");
	});
});

describe("resolveDefinition", () => {
	const resolve = (inputs: Record<string, unknown>, d = definition()) =>
		resolveDefinition(d, inputs);
	const issues = (inputs: Record<string, unknown>, d = definition()) => {
		const r = resolve(inputs, d);
		return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
	};

	test("replaces every $input and leaves literals as they are", () => {
		const r = resolve({ keyword: "電気ケトル" });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.steps[0]).toMatchObject({
			action: "browser.navigate",
			args: { url: "https://ja.wikipedia.org/" },
		});
		expect(r.steps[1]).toMatchObject({
			action: "page.fill",
			targetObject: "site.search_box",
			args: { value: "電気ケトル", submit: true },
		});
		expect(r.steps[2] as unknown).toEqual(definition().steps[2]);
		expect(r.steps[3] as unknown).toEqual(definition().steps[3]);
	});

	test("does not change the definition", () => {
		const d = definition();
		const before = JSON.stringify(d);
		resolve({ keyword: "x" }, d);
		expect(JSON.stringify(d)).toBe(before);
	});

	test("inputs are exactly the declared properties", () => {
		expect(issues({ keyword: "a", other: "b" })).toEqual([
			"inputs.other:unknown_input",
		]);
		expect(issues({ keyword: "a", "bad key!": "b" })).toEqual([
			"inputs.?:unknown_input",
		]);
	});

	test("required inputs are present", () => {
		expect(issues({})).toEqual(["inputs.keyword:missing_input"]);
		expect(issues({ keyword: undefined })).toEqual([
			"inputs.keyword:missing_input",
		]);
	});

	test("an optional input may be left out", () => {
		const d = changed((x) => {
			x.inputs.required = [];
			x.steps[1].args.value = "固定";
		});
		const parsed = parseDefinition(d);
		expect(parsed.ok && resolve({}, parsed.definition).ok).toBe(true);
	});

	test("values are strings within the lengths, counted in characters", () => {
		expect(issues({ keyword: 1 })).toEqual(["inputs.keyword:not_string"]);
		expect(issues({ keyword: null })).toEqual(["inputs.keyword:not_string"]);
		expect(issues({ keyword: "" })).toEqual(["inputs.keyword:too_short"]);
		expect(issues({ keyword: "あ".repeat(21) })).toEqual([
			"inputs.keyword:too_long",
		]);
		expect(issues({ keyword: "あ".repeat(20) })).toEqual([]);
		expect(issues({ keyword: "😀".repeat(20) })).toEqual([]);
	});

	test("control characters other than tab are refused", () => {
		for (const bad of [
			"a\nb",
			"a\rb",
			"a\u0000b",
			"a\u001bb",
			"a\u007fb",
			"a\u0085b",
		])
			expect(issues({ keyword: bad })).toEqual([
				"inputs.keyword:control_character",
			]);
		expect(issues({ keyword: "a\tb" })).toEqual([]);
	});

	test("strings are normalised to NFC before the length is checked and the value is used", () => {
		const decomposed = "が"; // か + combining dakuten, two code points
		const r = resolve({ keyword: decomposed });
		expect(r.ok).toBe(true);
		if (r.ok)
			expect((r.steps[1] as { args: { value: string } }).args.value).toBe("が");
		const d = changed((x) => (x.inputs.properties.keyword.maxLength = 1));
		const parsed = parseDefinition(d);
		expect(
			parsed.ok && resolve({ keyword: decomposed }, parsed.definition).ok,
		).toBe(true);
	});

	test("a url from an input must pass the https and origin rules again", () => {
		const d = changed((x) => {
			x.inputs.properties.target = { type: "string", maxLength: 200 };
			x.inputs.required.push("target");
			x.steps[0].args.url = { $input: "target" };
		});
		const parsed = parseDefinition(d);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const at = (target: string) =>
			issues({ keyword: "a", target }, parsed.definition);
		expect(at("https://en.wikipedia.org/wiki/A")).toEqual([]);
		expect(at("http://en.wikipedia.org/")).toEqual([
			"steps.0.args.url:url_not_https",
		]);
		expect(at("https://evil.example.com/")).toEqual([
			"steps.0.args.url:url_origin_not_allowed",
		]);
		expect(at("https://u@en.wikipedia.org/")).toEqual([
			"steps.0.args.url:url_userinfo",
		]);
	});

	test("issues never contain an input value", () => {
		const secret = "s3cr3t-value\n";
		const results = [
			issues({ keyword: secret }),
			issues({ keyword: secret.repeat(5) }),
			issues({ keyword: "a", [secret]: secret }),
			issues({ keyword: "a", secret }),
		];
		expect(results.every((r) => r.length > 0)).toBe(true);
		expect(JSON.stringify(results)).not.toContain("s3cr3t");
		const d = changed((x) => {
			x.inputs.properties.target = { type: "string", maxLength: 200 };
			x.inputs.required.push("target");
			x.steps[0].args.url = { $input: "target" };
		});
		const parsed = parseDefinition(d);
		if (!parsed.ok) throw new Error("valid");
		const bad = issues(
			{ keyword: "a", target: "https://s3cr3t.example.net/" },
			parsed.definition,
		);
		expect(bad).toEqual(["steps.0.args.url:url_origin_not_allowed"]);
	});
});

describe("sha256Hex", () => {
	test("known vectors", () => {
		expect(sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(
			sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
		).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
		expect(sha256Hex("a".repeat(1_000_000))).toBe(
			"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
		);
	});

	test("agrees with node:crypto around the padding boundaries and on multibyte text", () => {
		for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000])
			for (const unit of ["x", "あ", "😀"]) {
				const text = unit.repeat(length);
				expect(sha256Hex(text)).toBe(
					createHash("sha256").update(text).digest("hex"),
				);
			}
		const lone = "a\ud800b";
		expect(sha256Hex(lone)).toBe(
			createHash("sha256").update(lone).digest("hex"),
		);
	});
});

describe("definitionDigest", () => {
	test("is the sha256 of the canonical JSON", () => {
		const d = definition();
		expect(definitionDigest(d)).toBe(sha256Hex(canonicalJson(d)));
		expect(definitionDigest(d)).toMatch(/^[0-9a-f]{64}$/);
	});

	test("does not depend on key order", () => {
		const d = definition();
		const reversed = JSON.parse(
			JSON.stringify(d, (_k, v) =>
				v && typeof v === "object" && !Array.isArray(v)
					? Object.fromEntries(Object.entries(v).reverse())
					: v,
			),
		) as WorkDefinition;
		expect(Object.keys(reversed)).not.toEqual(Object.keys(d));
		expect(definitionDigest(reversed)).toBe(definitionDigest(d));
	});

	test("changes with any content change, and with step order", () => {
		const d = definition();
		const base = definitionDigest(d);
		expect(definitionDigest({ ...d, revision: 2 })).not.toBe(base);
		expect(definitionDigest({ ...d, steps: [...d.steps].reverse() })).not.toBe(
			base,
		);
	});

	test("canonical JSON sorts keys recursively without whitespace", () => {
		expect(canonicalJson({ b: [1, { z: true, a: "x" }], a: 0.5 })).toBe(
			'{"a":0.5,"b":[1,{"a":"x","z":true}]}',
		);
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
	});
});

describe("originAllowed", () => {
	const table: [string[], string, boolean][] = [
		[["https://example.org"], "https://example.org", true],
		[["https://example.org"], "https://example.org:443", true],
		[["https://example.org"], "HTTPS://Example.ORG", true],
		[["https://example.org"], "https://www.example.org", false],
		[["https://example.org"], "http://example.org", false],
		[["https://example.org"], "https://example.org:8443", false],
		[["https://example.org:8443"], "https://example.org:8443", true],
		[["https://example.org:8443"], "https://example.org", false],
		[["https://*.example.org"], "https://example.org", true],
		[["https://*.example.org"], "https://www.example.org", true],
		[["https://*.example.org"], "https://a.b.c.example.org", true],
		[["https://*.example.org"], "https://example.org:443", true],
		[["https://*.example.org"], "https://www.example.org:8443", false],
		[["https://*.example.org"], "http://www.example.org", false],
		[["https://*.example.org"], "https://evilexample.org", false],
		[["https://*.example.org"], "https://example.org.evil.com", false],
		[["https://*.example.org"], "https://www.example.org.evil.com", false],
		[["https://*.example.org"], "https://xexample.org", false],
		[["https://*.example.org"], "https://example.org@evil.com", false],
		[["https://*.example.org"], "https://example.org/path", false],
		[["https://*.example.org"], "https://example.org\\@evil.com", false],
		[["https://*.example.org"], "https://.example.org", false],
		[["https://*.example.org"], "https://example.org.", false],
		[["https://*.example.org"], "", false],
		[["https://*.example.org:8443"], "https://www.example.org:8443", false],
		[
			["https://a.example.org", "https://*.wikipedia.org"],
			"https://ja.wikipedia.org",
			true,
		],
		[
			["https://a.example.org", "https://*.wikipedia.org"],
			"https://b.example.org",
			false,
		],
		[[], "https://example.org", false],
		[["not an origin"], "https://example.org", false],
	];
	for (const [patterns, origin, allowed] of table)
		test(`${patterns.join(",")} ${allowed ? "allows" : "refuses"} ${origin}`, () => {
			expect(originAllowed(patterns, origin)).toBe(allowed);
		});
});

describe("definitionJsonSchema and definitionApi", () => {
	test("the JSON Schema describes the definition", () => {
		const schema = definitionJsonSchema() as {
			type: string;
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(schema.type).toBe("object");
		expect(Object.keys(schema.properties)).toEqual(
			expect.arrayContaining([
				"formatVersion",
				"id",
				"allowedOrigins",
				"inputs",
				"steps",
			]),
		);
		expect(schema.required).toContain("steps");
	});

	test("definitionApi is the contract's DefinitionApi", () => {
		expect(Object.keys(definitionApi).sort()).toEqual([
			"definitionDigest",
			"definitionJsonSchema",
			"originAllowed",
			"parseDefinition",
			"resolveDefinition",
		]);
	});
});
