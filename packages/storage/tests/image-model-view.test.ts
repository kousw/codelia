import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImageArtifactRef } from "@codelia/shared-types";
import sharp from "sharp";
import { ImageArtifactStore } from "../src";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
const fixture = async (transparent = false) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-model-view-"));
	roots.push(root);
	const pixels = Buffer.alloc(512 * 512 * 4);
	let seed = 17;
	for (let i = 0; i < pixels.length; i += 4) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		pixels[i] = seed & 255;
		pixels[i + 1] = (seed >>> 8) & 255;
		pixels[i + 2] = (seed >>> 16) & 255;
		pixels[i + 3] = transparent && i === 0 ? 0 : 255;
	}
	const bytes = await sharp(pixels, {
		raw: { width: 512, height: 512, channels: 4 },
	})
		.png()
		.toBuffer();
	const store = new ImageArtifactStore(root);
	const metadata = await store.save(bytes, {
		provider: "fixture",
		requested_model: "fixture",
		endpoint: "fixture",
		parent_artifact_ids: [],
	});
	return { store, metadata, bytes };
};

test("new model views reduce transfer bytes while old references and originals survive unchanged", async () => {
	const { store, metadata, bytes } = await fixture();
	const originalMetadata = await readFile(
		path.join(store.root, metadata.artifact_id, "metadata.json"),
	);
	const oldInput = await store.resolve(metadata);
	const [ref, concurrent] = await Promise.all([
		store.modelReference(metadata.artifact_id),
		store.modelReference(metadata.artifact_id),
	]);
	expect(ref).toEqual(concurrent);
	expect(ref.model_view?.media_type).toBe("image/jpeg");
	expect(ref.model_view?.byte_size).toBeLessThan(bytes.length);
	const input = await store.resolve(ref);
	expect(input.image_url.media_type).toBe("image/jpeg");
	expect(await store.resolve(metadata)).toEqual(oldInput);
	expect((await store.read(metadata.artifact_id)).bytes).toEqual(bytes);
	expect(
		await readFile(
			path.join(store.root, metadata.artifact_id, "metadata.json"),
		),
	).toEqual(originalMetadata);
	const persisted: ImageArtifactRef = JSON.parse(JSON.stringify(ref));
	const reopened = new ImageArtifactStore(store.root);
	expect(await reopened.resolve(persisted)).toEqual(input);
	expect(await reopened.modelReference(metadata.artifact_id)).toEqual(ref);
	expect(
		await reopened.resolve(
			await reopened.modelReference(metadata.artifact_id, true),
		),
	).toEqual(oldInput);
	const jpeg = Buffer.from(input.image_url.url.split(",")[1] ?? "", "base64");
	expect(await sharp(jpeg).metadata()).toMatchObject({
		format: "jpeg",
		width: 512,
		height: 512,
		chromaSubsampling: "4:4:4",
	});
});

test("attachments and transparent generated images retain exact original input", async () => {
	const opaque = await fixture();
	const attached = await opaque.store.saveAttachment(opaque.bytes, "image/png");
	expect(
		(await opaque.store.modelReference(attached.artifact_id)).model_view,
	).toBeUndefined();
	const transparent = await fixture(true);
	const ref = await transparent.store.modelReference(
		transparent.metadata.artifact_id,
	);
	expect(ref.model_view).toBeUndefined();
	expect((await transparent.store.resolve(ref)).image_url.url).toBe(
		`data:image/png;base64,${transparent.bytes.toString("base64")}`,
	);
});

test("missing, corrupt, symlinked or mismatched admitted views never rebuild or fall back", async () => {
	const { store, metadata } = await fixture();
	const ref = await store.modelReference(metadata.artifact_id);
	const view = ref.model_view;
	if (!view) throw Error("expected JPEG view");
	await expect(
		store.resolve({ ...ref, model_view: { ...view, sha256: "0".repeat(64) } }),
	).rejects.toThrow("mismatch");
	await expect(
		store.resolve({
			...ref,
			model_view: { ...view, version: "../../escape" },
		} as unknown as ImageArtifactRef),
	).rejects.toThrow("Invalid");
	await expect(
		store.resolve({ ...ref, model_view: null } as unknown as ImageArtifactRef),
	).rejects.toThrow("Invalid");
	const file = path.join(store.root, ref.artifact_id, view.version, "view.jpg");
	await writeFile(file, "corrupt");
	await expect(store.resolve(ref)).rejects.toThrow();
	await rm(file);
	await expect(store.resolve(ref)).rejects.toThrow();
	await symlink(path.join(store.root, ref.artifact_id, "original.png"), file);
	await expect(store.resolve(ref)).rejects.toThrow();
	expect((await store.resolve(metadata)).image_url.media_type).toBe(
		"image/png",
	);
});
