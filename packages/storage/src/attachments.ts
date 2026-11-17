import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AttachmentRef, ImageArtifactRef } from "@codelia/shared-types";
import type { ImageArtifactStore } from "./image-artifacts";
import { readImageFileBounded } from "./image-files";

export type StoredAttachment = {
	ref: AttachmentRef;
	imageRef?: ImageArtifactRef;
};

/** Host-owned originals and ownership index. commit must publish the entire batch atomically. */
export type AttachmentStore = {
	commit(
		sessionId: string,
		entries: readonly { record: StoredAttachment; bytes: Buffer }[],
	): Promise<void>;
	/** Validate ownership and integrity before returning an admitted reference. */
	lookup(
		attachmentId: string,
		sessionId: string,
	): Promise<StoredAttachment | null>;
	/** Check ownership and integrity of the returned byte range. */
	read(
		attachmentId: string,
		sessionId: string,
		offset: number,
		length: number,
	): Promise<Uint8Array>;
	resolveImage?: ImageArtifactStore["resolve"];
};

const ID = /^codelia-attachment-[0-9a-f-]{36}$/;
const UUID = /^[0-9a-f-]{36}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BYTES = 32 * 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;
const digest = (bytes: Buffer): string =>
	createHash("sha256").update(bytes).digest("hex");

export const createAttachmentId = (): string =>
	`codelia-attachment-${randomUUID()}`;
export const isAttachmentId = (id: string): boolean => ID.test(id);

type Metadata = StoredAttachment & {
	sessionId: string;
	batch: string;
	blocks?: string[];
};

/** An ownership marker makes every member of a batch visible at once. */
export class FileAttachmentStore implements AttachmentStore {
	constructor(
		readonly root: string,
		private readonly images: ImageArtifactStore,
	) {}

	resolveImage: NonNullable<AttachmentStore["resolveImage"]> = (ref) =>
		this.images.resolve(ref);

	async commit(
		sessionId: string,
		entries: readonly { record: StoredAttachment; bytes: Buffer }[],
	): Promise<void> {
		if (!entries.length) return;
		const batch = randomUUID();
		const marker = path.join(this.root, "committed", batch);
		await mkdir(path.join(this.root, "committed"), {
			recursive: true,
			mode: 0o700,
		});
		const created: string[] = [];
		const createdImages: ImageArtifactRef[] = [];
		try {
			for (const { record, bytes } of entries) {
				const { ref, imageRef } = record;
				if (
					!isAttachmentId(ref.attachment_id) ||
					bytes.length !== ref.byte_size ||
					bytes.length > MAX_BYTES ||
					digest(bytes) !== ref.sha256
				) {
					throw new Error("Invalid attachment original");
				}
				const dir = path.join(this.root, ref.attachment_id);
				await mkdir(dir, { mode: 0o700 });
				created.push(dir);
				const metadata: Metadata = { ...record, sessionId, batch };
				if (imageRef) {
					await this.images.saveAttachment(bytes, imageRef.media_type, {
						artifactId: imageRef.artifact_id,
						ownerSessionId: sessionId,
					});
					createdImages.push(imageRef);
				} else {
					metadata.blocks = [];
					for (let offset = 0; offset < bytes.length; offset += BLOCK_BYTES) {
						metadata.blocks.push(
							digest(bytes.subarray(offset, offset + BLOCK_BYTES)),
						);
					}
					await writeFile(path.join(dir, "original"), bytes, {
						flag: "wx",
						mode: 0o600,
					});
				}
				await writeFile(
					path.join(dir, "metadata.json"),
					JSON.stringify(metadata),
					{ flag: "wx", mode: 0o600 },
				);
			}
			await writeFile(`${marker}.pending`, "", { flag: "wx", mode: 0o600 });
			await rename(`${marker}.pending`, marker);
		} catch (error) {
			await Promise.allSettled([
				...created.map((dir) => rm(dir, { force: true, recursive: true })),
				...createdImages.map((ref) =>
					this.images.discardUnpublishedAttachment(ref, sessionId),
				),
				rm(`${marker}.pending`, { force: true }),
			]);
			throw error;
		}
	}

	async lookup(
		attachmentId: string,
		sessionId: string,
	): Promise<StoredAttachment | null> {
		const metadata = await this.metadata(attachmentId, sessionId);
		if (!metadata) return null;
		const { ref, imageRef } = metadata;
		if (imageRef) {
			await this.readImage(metadata);
		} else {
			const bytes = await readImageFileBounded(
				path.join(this.root, attachmentId, "original"),
				ref.byte_size,
			);
			if (bytes.length !== ref.byte_size || digest(bytes) !== ref.sha256)
				throw new Error("Attachment original is corrupt");
		}
		return { ref, ...(imageRef ? { imageRef } : {}) };
	}

	async read(
		attachmentId: string,
		sessionId: string,
		offset: number,
		length: number,
	): Promise<Uint8Array> {
		const metadata = await this.metadata(attachmentId, sessionId);
		if (!metadata) throw new Error("Attachment unavailable in this session");
		if (
			!Number.isSafeInteger(offset) ||
			!Number.isSafeInteger(length) ||
			offset < 0 ||
			length < 0 ||
			length > 256 * 1024
		)
			throw new Error("Invalid attachment byte range");
		const end = Math.min(offset + length, metadata.ref.byte_size);
		if (metadata.imageRef)
			return (await this.readImage(metadata)).subarray(offset, end);
		const file = await open(
			path.join(this.root, attachmentId, "original"),
			constants.O_RDONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(constants.O_NONBLOCK ?? 0),
		);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size !== metadata.ref.byte_size)
				throw new Error("Attachment original is corrupt");
			if (offset >= end) return Buffer.alloc(0);
			const firstBlock = Math.floor(offset / BLOCK_BYTES);
			const lastBlock = Math.ceil(end / BLOCK_BYTES);
			const start = firstBlock * BLOCK_BYTES;
			const bytes = Buffer.alloc(
				Math.min(lastBlock * BLOCK_BYTES, stat.size) - start,
			);
			let count = 0;
			while (count < bytes.length) {
				const result = await file.read(
					bytes,
					count,
					bytes.length - count,
					start + count,
				);
				if (!result.bytesRead)
					throw new Error("Attachment original is corrupt");
				count += result.bytesRead;
			}
			for (let block = firstBlock; block < lastBlock; block++) {
				const beg = (block - firstBlock) * BLOCK_BYTES;
				if (
					metadata.blocks?.[block] !==
					digest(bytes.subarray(beg, beg + BLOCK_BYTES))
				) {
					throw new Error("Attachment original is corrupt");
				}
			}
			return bytes.subarray(offset - start, end - start);
		} finally {
			await file.close();
		}
	}

	private async metadata(
		attachmentId: string,
		sessionId: string,
	): Promise<Metadata | null> {
		if (!isAttachmentId(attachmentId)) return null;
		const dir = path.join(this.root, attachmentId);
		try {
			if (!(await lstat(dir)).isDirectory()) return null;
			const metadata = JSON.parse(
				(
					await readImageFileBounded(path.join(dir, "metadata.json"), 64 * 1024)
				).toString(),
			) as Metadata;
			const { ref, imageRef, blocks } = metadata;
			if (
				metadata.sessionId !== sessionId ||
				!UUID.test(metadata.batch) ||
				ref?.attachment_id !== attachmentId
			)
				return null;
			if (
				!Number.isSafeInteger(ref.byte_size) ||
				ref.byte_size < 0 ||
				ref.byte_size > MAX_BYTES ||
				!SHA256.test(ref.sha256) ||
				typeof ref.media_type !== "string" ||
				typeof ref.display_name !== "string"
			)
				throw new Error("Invalid attachment metadata");
			if (
				!imageRef &&
				(!Array.isArray(blocks) ||
					blocks.length !== Math.ceil(ref.byte_size / BLOCK_BYTES))
			)
				throw new Error("Invalid attachment block index");
			const marker = path.join(this.root, "committed", metadata.batch);
			return (await lstat(marker)).isFile() ? metadata : null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	private async readImage({
		ref,
		imageRef,
		sessionId,
	}: Metadata): Promise<Buffer> {
		if (
			!imageRef ||
			imageRef.sha256 !== ref.sha256 ||
			imageRef.byte_size !== ref.byte_size ||
			imageRef.media_type !== ref.media_type ||
			imageRef.width !== ref.width ||
			imageRef.height !== ref.height
		)
			throw new Error("Invalid image attachment reference");
		const { metadata, bytes } = await this.images.read(
			imageRef.artifact_id,
			sessionId,
		);
		if (
			metadata.kind !== "attachment" ||
			metadata.sha256 !== ref.sha256 ||
			metadata.byte_size !== ref.byte_size ||
			metadata.media_type !== ref.media_type ||
			metadata.width !== ref.width ||
			metadata.height !== ref.height
		)
			throw new Error("Image attachment original is corrupt");
		return bytes;
	}
}
