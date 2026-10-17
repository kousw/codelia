import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	type ImageArtifactMetadata,
	type ImageModelView,
	isImageModelView,
} from "@codelia/shared-types";
import { imageSize } from "image-size";
import { imageHash, readImageFileBounded } from "./image-files";

const VERSION = "jpeg-q90-444-v1";
const directory = (root: string) => path.join(root, VERSION);
const errorCode = (error: unknown): unknown =>
	error && typeof error === "object" && "code" in error
		? error.code
		: undefined;

/** Reads only persisted bytes; never rebuilds or falls back during history replay. */
export async function readModelView(
	root: string,
	original: ImageArtifactMetadata,
	expected?: ImageModelView,
): Promise<{ view: ImageModelView; bytes: Buffer }> {
	if (expected !== undefined && !isImageModelView(expected))
		throw new Error("Invalid image model view");
	const dir = directory(root);
	if (!(await lstat(dir)).isDirectory())
		throw new Error("Invalid model view directory");
	const record = JSON.parse(
		(
			await readImageFileBounded(path.join(dir, "metadata.json"), 4096)
		).toString(),
	);
	if (
		!record ||
		record.original_sha256 !== original.sha256 ||
		!isImageModelView(record.view)
	)
		throw new Error("Invalid model view metadata");
	const view: ImageModelView = record.view;
	if (
		expected &&
		(view.sha256 !== expected.sha256 || view.byte_size !== expected.byte_size)
	)
		throw new Error("Image model view reference mismatch");
	const bytes = await readImageFileBounded(
		path.join(dir, "view.jpg"),
		8 * 1024 * 1024,
	);
	const dims = imageSize(bytes);
	if (
		bytes[0] !== 0xff ||
		bytes[1] !== 0xd8 ||
		dims.type !== "jpg" ||
		dims.width !== original.width ||
		dims.height !== original.height ||
		bytes.length !== view.byte_size ||
		imageHash(bytes) !== view.sha256
	)
		throw new Error("Corrupt image model view");
	return { view, bytes };
}

/** Only new admissions call this. Attachments, transparency and small images stay original. */
export async function prepareModelView(
	root: string,
	original: ImageArtifactMetadata,
	bytes: Buffer,
): Promise<ImageModelView | undefined> {
	if (original.kind === "attachment" || bytes.length < 256 * 1024)
		return undefined;
	let exists = true;
	try {
		await lstat(directory(root));
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		exists = false;
	}
	if (exists) return (await readModelView(root, original)).view;
	const { default: sharp } = await import("sharp");
	const pipeline = sharp(bytes, {
		limitInputPixels: 16_000_000,
		failOn: "warning",
	}).timeout({ seconds: 15 });
	const metadata = await pipeline.metadata();
	if (
		(metadata.pages ?? 1) > 1 ||
		(metadata.hasAlpha && !(await pipeline.clone().stats()).isOpaque)
	)
		return undefined;
	const jpeg = await pipeline
		.jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
		.toBuffer();
	if (jpeg.length >= bytes.length) return undefined;
	const view: ImageModelView = {
		version: VERSION,
		media_type: "image/jpeg",
		sha256: imageHash(jpeg),
		byte_size: jpeg.length,
	};
	const temporary = path.join(root, `.model-view-${randomUUID()}`);
	await mkdir(temporary, { mode: 0o700 });
	try {
		await writeFile(path.join(temporary, "view.jpg"), jpeg, {
			flag: "wx",
			mode: 0o600,
		});
		await writeFile(
			path.join(temporary, "metadata.json"),
			JSON.stringify({ original_sha256: original.sha256, view }),
			{ flag: "wx", mode: 0o600 },
		);
		try {
			await rename(temporary, directory(root));
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes(String(errorCode(error))))
				throw error;
			// Another admission won; both callers use the already persisted representation.
		}
		return (await readModelView(root, original)).view;
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
