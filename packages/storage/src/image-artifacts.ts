import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	AttachedImageMetadata,
	GeneratedImageMetadata,
	ImageArtifactMetadata,
	ImageArtifactRef,
	ImageMediaType,
} from "@codelia/shared-types";
import {
	imageOriginalFilename,
	validateImageAttachment,
} from "./image-attachment";
import {
	imageHash as hash,
	readImageFileBounded as readBounded,
} from "./image-files";
import { parseImageMetadata } from "./image-metadata";
import { prepareModelView, readModelView } from "./image-model-view";
import { IMAGE_MAX_BYTES, validateImagePng } from "./image-png";

const ID = /^codelia-image-[0-9a-f-]{36}$/;
/** A workspace-scoped store. No TTL deletion: references must survive session resume. */
export class ImageArtifactStore {
	constructor(readonly root: string) {}
	async save(
		bytes: Buffer,
		provenance: Omit<
			GeneratedImageMetadata,
			keyof ImageArtifactRef | "created_at"
		>,
	): Promise<GeneratedImageMetadata> {
		const dimensions = await validateImagePng(bytes);
		const artifact_id = `codelia-image-${randomUUID()}`;
		const metadata = parseImageMetadata({
			...provenance,
			...dimensions,
			artifact_id,
			sha256: hash(bytes),
			media_type: "image/png",
			byte_size: bytes.length,
			created_at: new Date().toISOString(),
		});
		if (metadata.kind === "attachment")
			throw new Error("Invalid generation provenance");
		await this.persist(bytes, metadata);
		return metadata;
	}
	async saveAttachment(
		bytes: Buffer,
		mediaType: ImageMediaType,
	): Promise<AttachedImageMetadata> {
		const dimensions = validateImageAttachment(bytes, mediaType);
		const metadata: AttachedImageMetadata = {
			kind: "attachment",
			artifact_id: `codelia-image-${randomUUID()}`,
			sha256: hash(bytes),
			media_type: mediaType,
			byte_size: bytes.length,
			...dimensions,
			created_at: new Date().toISOString(),
		};
		await this.persist(bytes, metadata);
		return metadata;
	}
	private async persist(
		bytes: Buffer,
		metadata: ImageArtifactMetadata,
	): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const temporary = path.join(this.root, `.pending-${randomUUID()}`);
		await mkdir(temporary, { mode: 0o700 });
		try {
			await writeFile(
				path.join(temporary, imageOriginalFilename(metadata.media_type)),
				bytes,
				{
					flag: "wx",
					mode: 0o600,
				},
			);
			await writeFile(
				path.join(temporary, "metadata.json"),
				JSON.stringify(metadata),
				{ flag: "wx", mode: 0o600 },
			);
			await rename(temporary, path.join(this.root, metadata.artifact_id));
		} catch (error) {
			await rm(temporary, { recursive: true, force: true });
			throw error;
		}
	}
	async read(
		artifactId: string,
	): Promise<{ metadata: ImageArtifactMetadata; bytes: Buffer }> {
		if (!ID.test(artifactId)) throw new Error("Invalid image artifact id");
		try {
			const dir = path.join(this.root, artifactId);
			if (!(await lstat(dir)).isDirectory())
				throw new Error("Invalid artifact directory");
			const metadata = parseImageMetadata(
				JSON.parse(
					(
						await readBounded(path.join(dir, "metadata.json"), 16384)
					).toString(),
				),
			);
			const bytes = await readBounded(
				path.join(dir, imageOriginalFilename(metadata.media_type)),
				IMAGE_MAX_BYTES,
			);
			const dims =
				metadata.kind === "attachment"
					? validateImageAttachment(bytes, metadata.media_type)
					: await validateImagePng(bytes);
			if (
				metadata.artifact_id !== artifactId ||
				metadata.byte_size !== bytes.length ||
				metadata.sha256 !== hash(bytes) ||
				metadata.width !== dims.width ||
				metadata.height !== dims.height
			)
				throw new Error("Invalid artifact metadata");
			return { metadata, bytes };
		} catch {
			throw new Error(
				"Image artifact missing, corrupt, or inaccessible in this workspace",
			);
		}
	}
	/** Prepare a new history reference, never upgrade an already persisted reference. */
	async modelReference(
		artifactId: string,
		original = false,
	): Promise<ImageArtifactRef> {
		const { metadata, bytes } = await this.read(artifactId);
		const { artifact_id, sha256, media_type, byte_size, width, height } =
			metadata;
		const ref: ImageArtifactRef = {
			artifact_id,
			sha256,
			media_type,
			byte_size,
			width,
			height,
		};
		if (original) return ref;
		const model_view = await prepareModelView(
			path.join(this.root, artifactId),
			metadata,
			bytes,
		);
		return model_view ? { ...ref, model_view } : ref;
	}
	async resolve(ref: ImageArtifactRef): Promise<{
		type: "image_url";
		image_url: { url: string; media_type: ImageMediaType };
	}> {
		const { metadata, bytes } = await this.read(ref.artifact_id);
		if (
			metadata.sha256 !== ref.sha256 ||
			metadata.byte_size !== ref.byte_size ||
			metadata.media_type !== ref.media_type ||
			metadata.width !== ref.width ||
			metadata.height !== ref.height
		)
			throw new Error("Image artifact reference mismatch");
		const input =
			ref.model_view !== undefined
				? await readModelView(
						path.join(this.root, ref.artifact_id),
						metadata,
						ref.model_view,
					)
				: { bytes, view: metadata };
		return {
			type: "image_url",
			image_url: {
				url: `data:${input.view.media_type};base64,${input.bytes.toString("base64")}`,
				media_type: input.view.media_type,
			},
		};
	}
}
