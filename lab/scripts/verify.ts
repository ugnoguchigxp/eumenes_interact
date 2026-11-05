/** Reproducible, credential-free gate. Paid scripts are intentionally separate explicit invocations. */
export {};
const checks = [
	["typecheck"],
	["typecheck:core"],
	["lint"],
	["format:check"],
	["check:collab"],
	["test"],
	["check:dist"],
	["check:package"],
];
for (const args of checks) {
	const child = Bun.spawn(["bun", "run", ...args], {
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await child.exited;
	if (code) process.exit(code);
}
if (process.env.LAB_BROWSER_TESTS === "1") {
	const child = Bun.spawn(
		["bun", "test", "lab/test/host/net-guard.browser.test.ts"],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if (await child.exited) process.exit(1);
}
console.log(
	"verify: all requested gates passed; Eumenes integration and paid API evaluation are separate recorded gates",
);
