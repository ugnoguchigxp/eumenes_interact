import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedImage } from "eumenes-interact";
import {
	CaptureError,
	CaptureStore,
	resolveCaptureDir,
} from "../../host/parts/capture.ts";
import { makePng } from "./fake-adapter.ts";

let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interact-capture-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const RUN = "0a1b2c3d-1111-2222-3333-444455556666";
const image = (width = 8, height = 4) => ({
	mediaType: "image/png" as const,
	bytes: makePng(width, height),
	width,
	height,
});

const refusal = async (run: () => unknown) => {
	try {
		await run();
	} catch (error) {
		return error instanceof CaptureError ? error.code : String(error);
	}
	return null;
};

describe("the capture directory the caller names", () => {
	test("only an existing absolute directory", () => {
		expect(resolveCaptureDir(root)).toBe(realpathSync(root));
		const code = (dir: string) => {
			try {
				resolveCaptureDir(dir);
			} catch (error) {
				return (error as CaptureError).code;
			}
			return null;
		};
		expect(code("relative/dir")).toBe("capture_dir_not_absolute");
		expect(code("")).toBe("capture_dir_invalid");
		expect(code(`${root}\0x`)).toBe("capture_dir_invalid");
		expect(code(join(root, "missing"))).toBe("capture_dir_missing");
		writeFileSync(join(root, "file"), "x");
		expect(code(join(root, "file"))).toBe("capture_dir_not_directory");
	});

	test("a symlink is followed to the real directory, and that is where files go", async () => {
		const real = join(root, "real");
		mkdirSync(real);
		const link = join(root, "link");
		symlinkSync(real, link);
		const store = new CaptureStore({ runId: RUN, dir: link });
		expect(store.dir).toBe(resolveCaptureDir(real));
		await store.save("viewport", image());
		expect(readdirSync(real)).toHaveLength(1);
	});

	test("a directory swapped for a link to somewhere else after the start is refused", async () => {
		const real = join(root, "real");
		const elsewhere = join(root, "elsewhere");
		mkdirSync(real);
		mkdirSync(elsewhere);
		const store = new CaptureStore({ runId: RUN, dir: real });
		await store.save("viewport", image());
		// The path the store holds is the resolved one; replace it with a link to another directory.
		renameSync(real, join(root, "moved"));
		symlinkSync(elsewhere, real);
		expect(await refusal(() => store.save("full", image()))).toBe(
			"capture_dir_changed",
		);
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	test("the directory removed after the start is refused too", async () => {
		const dir = join(root, "gone");
		mkdirSync(dir);
		const store = new CaptureStore({ runId: RUN, dir });
		rmSync(dir, { recursive: true });
		expect(await refusal(() => store.save("viewport", image()))).toBe(
			"capture_dir_missing",
		);
	});
});

describe("the files", () => {
	test("named from the run, the number and the range; read-only to others", async () => {
		const dir = join(root, "out");
		mkdirSync(dir);
		const store = new CaptureStore({ runId: RUN, dir });
		const a = await store.save("viewport", image());
		const b = await store.save("item", image(4, 4));
		expect(a).toMatchObject({
			captureId: "c1",
			fileName: "0a1b2c3d-1-viewport.png",
			width: 8,
			height: 4,
			mediaType: "image/png",
			range: "viewport",
		});
		expect(b.fileName).toBe("0a1b2c3d-2-item.png");
		expect(a.bytes).toBe(image().bytes.length);
		expect(statSync(join(dir, a.fileName)).mode & 0o777).toBe(0o600);
		expect(
			readFileSync(join(dir, a.fileName)).equals(Buffer.from(image().bytes)),
		).toBe(true);
	});

	test("a JPEG gets its own extension", async () => {
		const dir = join(root, "out");
		mkdirSync(dir);
		const store = new CaptureStore({ runId: RUN, dir });
		const saved = await store.save("full", {
			mediaType: "image/jpeg",
			bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
			width: 10,
			height: 10,
		});
		expect(saved.fileName).toBe("0a1b2c3d-1-full.jpg");
	});

	test("an existing file is never overwritten", async () => {
		const dir = join(root, "out");
		mkdirSync(dir);
		writeFileSync(join(dir, "0a1b2c3d-1-viewport.png"), "mine");
		const store = new CaptureStore({ runId: RUN, dir });
		expect(await refusal(() => store.save("viewport", image()))).toBe(
			"capture_exists",
		);
		expect(readFileSync(join(dir, "0a1b2c3d-1-viewport.png"), "utf8")).toBe(
			"mine",
		);
	});

	test("a link planted where the file goes is not followed", async () => {
		const dir = join(root, "out");
		const target = join(root, "victim.txt");
		mkdirSync(dir);
		writeFileSync(target, "victim");
		symlinkSync(target, join(dir, "0a1b2c3d-1-viewport.png"));
		const store = new CaptureStore({ runId: RUN, dir });
		expect(await refusal(() => store.save("viewport", image()))).toBe(
			"capture_exists",
		);
		expect(readFileSync(target, "utf8")).toBe("victim");
	});

	test("what is not an image, an empty image or one without a size is not saved", async () => {
		const dir = join(root, "out");
		mkdirSync(dir);
		const store = new CaptureStore({ runId: RUN, dir });
		const bad = (over: Partial<CapturedImage>) =>
			refusal(() => store.save("viewport", { ...image(), ...over }));
		expect(await bad({ bytes: new Uint8Array() })).toBe(
			"capture_invalid_image",
		);
		expect(await bad({ bytes: new Uint8Array([1, 2, 3, 4]) })).toBe(
			"capture_invalid_image",
		);
		expect(await bad({ width: 0 })).toBe("capture_invalid_image");
		expect(await bad({ height: 1.5 })).toBe("capture_invalid_image");
		expect(await bad({ mediaType: "image/jpeg" })).toBe(
			"capture_invalid_image",
		);
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("without a directory", () => {
	test("the lab's own area gets one directory per run, made when the first capture is saved", async () => {
		const store = new CaptureStore({ runId: RUN, defaultRoot: root });
		expect(store.dir).toBe(join(root, RUN));
		expect(existsSync(store.dir)).toBe(false);
		const saved = await store.save("viewport", image());
		expect(readdirSync(join(root, RUN))).toEqual([saved.fileName]);
		expect(statSync(join(root, RUN)).mode & 0o777).toBe(0o700);
	});
});
