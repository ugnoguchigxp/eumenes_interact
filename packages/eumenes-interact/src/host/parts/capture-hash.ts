import { createHash } from "node:crypto";
export function captureTargetHash(name: string): string {
	return createHash("sha256")
		.update(name.normalize("NFKC").trim())
		.digest("hex")
		.slice(0, 16);
}
