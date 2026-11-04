#!/usr/bin/env bash
# Re-runs the scripted arm1 dev split and compares it to the M0 golden (semantic JSON equality).
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
bun lab/cli/main.ts run --split dev --arm arm1 --inference scripted --browser chrome \
	--db "$tmp/g.sqlite" --capture-dir "$tmp" > "$tmp/run.log" 2>&1 || true
bun lab/golden/extract.ts "$tmp/run.log" > "$tmp/cur.json"
bun -e 'const [a,b]=process.argv.slice(1);const x=JSON.stringify(await Bun.file(a).json()),y=JSON.stringify(await Bun.file(b).json());if(x!==y){console.log("GOLDEN_DIFF");process.exit(1)}console.log("GOLDEN_IDENTICAL")' "$tmp/cur.json" lab/golden/m0-arm1-dev.json
