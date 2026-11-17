import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileAttachmentStore, ImageArtifactStore } from "@codelia/storage";
import {
	AttachmentTransferService,
	type AttachmentUploadPolicy,
} from "../src/attachments/service";
import { referenceJpeg64 } from "./image-source-fixtures";

const hash = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

async function fixture(
	limits?: Partial<AttachmentUploadPolicy>,
	now?: () => number,
) {
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-attachments-"));
	const images = new ImageArtifactStore(path.join(root, "images"));
	const store = new FileAttachmentStore(path.join(root, "attachments"), images);
	const transfer = new AttachmentTransferService(store, limits, now);
	const begin = (
		key: string,
		bytes: Buffer,
		sessionId: string | null = null,
		name = "文書 data.txt",
	) =>
		transfer.begin(
			{
				upload_key: key,
				display_name: name,
				byte_size: bytes.length,
				sha256: hash(bytes),
				...(sessionId ? { session_id: sessionId } : {}),
			},
			sessionId,
		);
	const upload = async (
		key: string,
		bytes: Buffer,
		sessionId: string | null = null,
		name?: string,
	) => {
		const { upload_id } = await begin(key, bytes, sessionId, name);
		if (bytes.length)
			await transfer.chunk(
				{ upload_id, offset: 0, data: bytes.toString("base64") },
				sessionId,
			);
		return (await transfer.finish(upload_id, sessionId)).attachment_id;
	};
	return {
		images,
		store,
		transfer,
		begin,
		upload,
		async cleanup() {
			await transfer.close();
			await rm(root, { force: true, recursive: true });
		},
	};
}

test("a completed draft upload acknowledges identical retries and remains readable only in its claimed session", async () => {
	const f = await fixture();
	try {
		const original = Buffer.concat([
			Buffer.from("a\r\nサンプル\r\nz"),
			Buffer.alloc(64 * 1024, 0x61),
		]);
		const { upload_id } = await f.begin(
			"stable-key",
			original,
			null,
			"C:\\private\\文書 data.txt",
		);
		const head = original.subarray(0, 6).toString("base64");
		const tail = original.subarray(6).toString("base64");
		await expect(
			f.transfer.chunk({ upload_id, offset: 6, data: tail }, null),
		).rejects.toThrow("out of order");
		await expect(
			f.transfer.chunk({ upload_id, offset: 0, data: head }, null),
		).resolves.toEqual({ offset: 6 });
		await expect(
			f.begin("stable-key", original, null, "文書 data.txt"),
		).resolves.toEqual({ upload_id, offset: 6 });
		await expect(f.begin("stable-key", Buffer.from("z"))).rejects.toThrow(
			"conflicts",
		);
		await expect(
			f.transfer.chunk({ upload_id, offset: 0, data: head }, null),
		).resolves.toEqual({ offset: 6 });
		await expect(
			f.transfer.chunk({ upload_id, offset: 0, data: "YmFk" }, null),
		).rejects.toThrow("conflicts");
		await f.transfer.chunk({ upload_id, offset: 6, data: tail }, null);
		const completed = await f.transfer.finish(upload_id, null);
		await expect(f.transfer.finish(upload_id, null)).resolves.toEqual(
			completed,
		);
		const id = completed.attachment_id;
		await expect(f.transfer.resolveForAdmission([id], "old")).rejects.toThrow(
			"unavailable",
		);
		expect(
			await f.transfer.resolveForAdmission([id], "new", { allowDraft: true }),
		).toEqual([
			{
				ref: {
					attachment_id: id,
					display_name: "文書 data.txt",
					media_type: "text/plain",
					origin: "file",
					byte_size: original.length,
					sha256: hash(original),
				},
			},
		]);
		await expect(
			f.transfer.read(id, "new", 0, original.length),
		).rejects.toThrow("unavailable");
		await expect(f.transfer.claim([id], "old")).rejects.toThrow("unavailable");
		await f.transfer.claim([id], "new", { allowDraft: true });
		await expect(f.transfer.cancel(id, "old")).rejects.toThrow("unavailable");
		await f.transfer.cancel(id, "new");
		await expect(f.transfer.finish(upload_id, "new")).resolves.toEqual(
			completed,
		);
		const reopened = new AttachmentTransferService(f.store);
		try {
			const bytes = await reopened.read(id, "new", 0, original.length);
			expect(Buffer.from(bytes)).toEqual(original);
			const crossBlock = await reopened.read(id, "new", 65535, 2);
			expect(Buffer.from(crossBlock)).toEqual(original.subarray(65535, 65537));
			await expect(reopened.claim([id], "old")).rejects.toThrow("unavailable");
			await expect(
				reopened.read(id, "old", 0, original.length),
			).rejects.toThrow("unavailable");
		} finally {
			await reopened.close();
		}
		await writeFile(
			path.join(f.store.root, id, "original"),
			Buffer.alloc(original.length),
		);
		await expect(f.transfer.resolveForAdmission([id], "new")).rejects.toThrow(
			"corrupt",
		);
		await expect(f.transfer.read(id, "new", 0, 1)).rejects.toThrow("corrupt");
	} finally {
		await f.cleanup();
	}
});

test("upload bounds, content validation, pins and draft replacement release staging predictably", async () => {
	let currentTime = 0;
	const f = await fixture(
		{
			max_staged_bytes: 2,
			max_staged_uploads: 1,
			max_concurrent_uploads: 1,
			max_chunk_bytes: 2,
			lease_ms: 1000,
		},
		() => currentTime,
	);
	try {
		const original = Buffer.from([0xff, 0x00]);
		const { upload_id } = await f.begin("broken", original);
		await expect(f.begin("oversized", Buffer.alloc(3))).rejects.toThrow(
			"staging is full",
		);
		await expect(
			f.transfer.chunk({ upload_id, offset: 0, data: "YWE" }, null),
		).rejects.toThrow("encoding");
		await f.transfer.chunk({ upload_id, offset: 0, data: "YWE=" }, null);
		await expect(f.transfer.finish(upload_id, null)).rejects.toThrow(
			"SHA-256 mismatch",
		);
		const id = await f.upload("good", original);
		f.transfer.bindDraft("first");
		const unpin = await f.transfer.pin([id], "first");
		currentTime += 1100;
		await f.transfer.cancel(id, "first");
		await expect(
			f.transfer.resolveForAdmission([id], "first"),
		).resolves.toMatchObject([
			{ ref: { media_type: "application/octet-stream" } },
		]);
		unpin();
		currentTime += 1100;
		await expect(f.transfer.resolveForAdmission([id], "first")).rejects.toThrow(
			"unavailable",
		);
		const newId = await f.upload("next-draft", original);
		f.transfer.discardDraft();
		await expect(f.transfer.finish(newId, null)).rejects.toThrow("expired");
		const empty = await f.upload("empty", Buffer.alloc(0));
		f.transfer.bindDraft("second");
		await f.transfer.claim([empty], "second");
		await expect(f.transfer.read(empty, "second", 0, 1)).resolves.toEqual(
			Buffer.alloc(0),
		);
		await expect(
			f.upload("quota-after-claim", original, "second"),
		).resolves.toBeString();
	} finally {
		await f.cleanup();
	}
});

test("a failed batch publishes no members and copied JPEG originals use the existing image store", async () => {
	const f = await fixture();
	try {
		const original = Buffer.from(referenceJpeg64, "base64");
		const jpg = await f.upload("jpeg", original, "snapshot", "コピー.jpg");
		const txt = await f.upload("text", Buffer.from("a"), "snapshot");
		const simulatedConflict = path.join(f.store.root, txt);
		const [resolved] = await f.transfer.resolveForAdmission([jpg], "snapshot");
		const provisionalImageId = resolved?.imageRef?.artifact_id;
		if (!provisionalImageId)
			throw new Error("Expected a provisional image reference");
		await mkdir(simulatedConflict, { recursive: true });
		await expect(f.transfer.claim([jpg, txt], "snapshot")).rejects.toThrow(
			"persist attachment originals",
		);
		await expect(f.store.lookup(jpg, "snapshot")).resolves.toBeNull();
		await expect(f.images.read(provisionalImageId, "snapshot")).rejects.toThrow(
			"missing",
		);
		await rm(simulatedConflict, { recursive: true });
		await f.transfer.claim([jpg, txt], "snapshot");
		const owned = await f.store.lookup(jpg, "snapshot");
		expect(owned?.ref).toMatchObject({
			display_name: "コピー.jpg",
			width: 2,
			height: 2,
			media_type: "image/jpeg",
			sha256: hash(original),
		});
		const imageId = owned?.imageRef?.artifact_id;
		if (!imageId) throw new Error("Expected an image reference");
		expect((await f.images.read(imageId, "snapshot")).bytes).toEqual(original);
		await expect(
			lstat(path.join(f.store.root, jpg, "original")),
		).rejects.toThrow("ENOENT");
	} finally {
		await f.cleanup();
	}
});
