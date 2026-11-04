/**
 * M0 golden baseline: turns the output of `lab run --inference scripted` into a stable JSON
 * (case, run status, scorer verdict, part-call sequence, approval stops, final step kind).
 * The fixture server port is normalized so runs compare byte for byte.
 * usage: bun lab/golden/extract.ts <run.log>  > golden.json
 */
const path = process.argv[2];
if (!path) throw new Error("usage: extract.ts <run.log>");
const text = await Bun.file(path).text();
type Trial = {
	caseId: string;
	status: string;
	verdict: string;
	finalStep: string;
	finalUrl: string;
	parts: string[];
	approvals: string[];
};
const trials: Trial[] = [];
let cur: Trial | null = null;
for (const raw of text.split("\n")) {
	const line = raw.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT");
	const t = line.match(/^trial\t(\S+)\t(\S+)\t(\S+)/);
	if (t) {
		cur = {
			caseId: t[1]!,
			status: t[2]!,
			verdict: t[3]!,
			finalStep: "",
			finalUrl: "",
			parts: [],
			approvals: [],
		};
		trials.push(cur);
		continue;
	}
	if (!cur) continue;
	const s = line.match(/^ {2}final step: (\S+)/);
	if (s) cur.finalStep = s[1]!;
	const u = line.match(/^ {2}final url: (\S+)/);
	if (u) cur.finalUrl = u[1]!;
	const p = line.match(/^ {2}parts: (.*)$/);
	if (p) {
		cur.parts = p[1]!.split(" > ");
		cur.approvals = cur.parts.filter((x) => x.includes("needs_approval"));
	}
}
console.log(JSON.stringify({ trials }, null, "\t"));

export {};
