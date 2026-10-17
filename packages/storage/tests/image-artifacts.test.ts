import { afterEach, expect, test } from "bun:test";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImageArtifactStore, validateImagePng } from "../src";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=",
	"base64",
);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
const store = async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-images-"));
	roots.push(root);
	return new ImageArtifactStore(root);
};
const provenance = {
	provider: "openai",
	requested_model: "test-image",
	endpoint: "image-api",
	parent_artifact_ids: [],
};

test("immutable originals, separate identities, durable reload and reference hash validation", async () => {
	const s = await store();
	const first = await s.save(png, provenance);
	const edited = await s.save(png, {
		...provenance,
		parent_artifact_ids: [first.artifact_id],
	});
	expect(first.artifact_id).not.toBe(edited.artifact_id);
	expect((await s.read(first.artifact_id)).bytes).toEqual(png);
	const { metadata } = await new ImageArtifactStore(s.root).read(
		edited.artifact_id,
	);
	if (metadata.kind === "attachment")
		throw new Error("Expected generated provenance");
	expect(metadata.parent_artifact_ids).toEqual([first.artifact_id]);
	expect((await s.resolve(first)).image_url.url).toBe(
		`data:image/png;base64,${png.toString("base64")}`,
	);
	await expect(s.resolve({ ...first, sha256: "0".repeat(64) })).rejects.toThrow(
		"mismatch",
	);
	if (process.platform !== "win32")
		expect(
			(await stat(path.join(s.root, first.artifact_id, "original.png"))).mode &
				0o777,
		).toBe(0o600);
	expect((await readdir(s.root)).some((n) => n.startsWith(".pending"))).toBe(
		false,
	);
});
test("invalid/truncated/CRC-corrupt and oversized images never create artifacts", async () => {
	const s = await store();
	const corrupt = Buffer.from(png);
	corrupt[20] ^= 1;
	for (const bytes of [
		Buffer.from("not PNG"),
		png.subarray(0, png.length - 1),
		corrupt,
		Buffer.alloc(8 * 1024 * 1024 + 1),
	])
		await expect(s.save(bytes, provenance)).rejects.toThrow();
	expect(await readdir(s.root)).toEqual([]);
	expect(await validateImagePng(png)).toEqual({ width: 2, height: 2 });
});
test("path traversal, cross-root reads, symlinks and tampering fail closed", async () => {
	const s = await store();
	const other = await store();
	const m = await s.save(png, provenance);
	await expect(s.read("../metadata.json")).rejects.toThrow(
		"Invalid image artifact id",
	);
	await expect(other.read(m.artifact_id)).rejects.toThrow("missing");
	const file = path.join(s.root, m.artifact_id, "original.png");
	expect(await readFile(file)).toEqual(png);
	await writeFile(file, Buffer.from("corrupt"));
	await expect(s.read(m.artifact_id)).rejects.toThrow("corrupt");
	await rm(file);
	await symlink(path.join(other.root, "missing"), file);
	await expect(s.read(m.artifact_id)).rejects.toThrow("inaccessible");
});

test("malformed persisted provenance cannot reach image results or UI", async () => {
	const s = await store();
	const m = await s.save(png, provenance);
	for (const extra of [
		{ provider: "bad\u001b[2J" },
		{ parent_artifact_ids: ["../escape"] },
		{ usage: { cost_usd: -1 } },
		{ created_at: "not a date" },
	]) {
		await writeFile(
			path.join(s.root, m.artifact_id, "metadata.json"),
			JSON.stringify({ ...m, ...extra }),
		);
		await expect(s.read(m.artifact_id)).rejects.toThrow("corrupt");
	}
});
