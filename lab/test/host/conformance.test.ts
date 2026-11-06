import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isPrivateAddress } from "../../host/net-guard.ts";
import { originPolicy } from "../../host/policy.ts";

/**
 * The research host against the vectors the package ships for every host (design R08,
 * packages/eumenes-interact/contract/HOST-CONTRACT.md): its live navigation policy with the open web allowed,
 * and its network guard's address check.
 */
const vectors = JSON.parse(
	readFileSync(
		new URL(
			"../../../packages/eumenes-interact/contract/host-vectors.json",
			import.meta.url,
		),
		"utf8",
	),
) as {
	urls: { url: string; allow: boolean }[];
	addresses: { address: string; private: boolean }[];
};

describe("host vectors", () => {
	const policy = originPolicy([], true);
	for (const v of vectors.urls)
		test(`navigation ${v.url}`, () => {
			expect(policy(v.url).ok).toBe(v.allow);
		});
	for (const v of vectors.addresses)
		test(`address ${v.address}`, () => {
			expect(isPrivateAddress(v.address)).toBe(v.private);
		});
});
