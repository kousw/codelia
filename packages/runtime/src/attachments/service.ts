import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type {
	AttachmentUploadBeginParams,
	AttachmentUploadBeginResult,
	AttachmentUploadChunkParams,
	AttachmentUploadChunkResult,
	AttachmentUploadFinishResult,
	AttachmentUploadLimits,
} from "@codelia/protocol";
import {
	type AttachmentStore,
	createAttachmentId,
	detectImageAttachmentType,
	isAttachmentId,
	type StoredAttachment,
	validateImageAttachment,
} from "@codelia/storage";

const MIB = 1024 * 1024;
const DEFAULT_LIMITS = {
	max_file_bytes: 32 * MIB,
	max_message_bytes: 64 * MIB,
	max_attachments: 8,
	max_chunk_bytes: 256 * 1024,
	max_concurrent_uploads: 2,
	max_image_bytes: 5 * MIB,
	max_images: 3,
	max_staged_bytes: 128 * MIB,
	max_staged_uploads: 128,
	lease_ms: 30 * 60 * 1000,
};

export type AttachmentUploadPolicy = typeof DEFAULT_LIMITS;

export class AttachmentUploadError extends Error {}

let processStagedBytes = 0;

const SHA256 = /^[a-f0-9]{64}$/;
const UPLOAD_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const digest = (buffer: Buffer): string =>
	createHash("sha256").update(buffer).digest("hex");

const safeDisplayName = (name: string): string => {
	if (typeof name !== "string" || name.length > 1024) {
		throw new AttachmentUploadError("Invalid attachment name");
	}
	const separator = /^(?:[A-Za-z]:|\\\\)/.test(name) ? /[\\/]/ : "/";
	const basename = name.split(separator).at(-1) ?? "";
	const safe = basename.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "_").trim();
	if (!safe || safe === "." || safe === ".." || Buffer.byteLength(safe) > 255) {
		throw new AttachmentUploadError("Invalid attachment name");
	}
	return safe;
};

const isText = (bytes: Buffer): boolean => {
	if (!isUtf8(bytes)) return false;
	for (const byte of bytes) {
		if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)
			return false;
	}
	return true;
};

type Upload = {
	id: string;
	key: string;
	sessionId: string | null;
	name: string;
	sha256: string;
	size: number;
	offset: number;
	bytes: Buffer | null;
	record?: StoredAttachment;
	expires: number;
	pins: number;
};

/** Connection-local draft and upload receipts with host-owned durable storage. */
export class AttachmentTransferService {
	readonly limits: Readonly<AttachmentUploadPolicy>;
	private readonly uploads = new Map<string, Upload>();
	private stagedBytes = 0;
	private closed = false;
	private operationActive = false;
	private queued: Promise<void> = Promise.resolve();
	private readonly expirationTimer: ReturnType<typeof setInterval>;

	constructor(
		private readonly store: AttachmentStore,
		limits: Partial<AttachmentUploadPolicy> = {},
		private readonly now: () => number = Date.now,
		private readonly getSessionId?: () => string | null,
	) {
		this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
		for (const key of Object.keys(
			DEFAULT_LIMITS,
		) as (keyof AttachmentUploadPolicy)[]) {
			const value = this.limits[key];
			if (
				!Number.isSafeInteger(value) ||
				value < 1 ||
				value > DEFAULT_LIMITS[key]
			) {
				throw new Error(`Invalid attachment upload limit ${key}`);
			}
		}
		this.expirationTimer = setInterval(
			() => {
				if (!this.operationActive) this.sweep();
			},
			Math.min(this.limits.lease_ms, 60_000),
		);
		this.expirationTimer.unref();
	}

	get wireLimits(): AttachmentUploadLimits {
		const {
			max_file_bytes,
			max_message_bytes,
			max_attachments,
			max_chunk_bytes,
			max_concurrent_uploads,
		} = this.limits;
		return {
			max_file_bytes,
			max_message_bytes,
			max_attachments,
			max_chunk_bytes,
			max_concurrent_uploads,
		};
	}

	get resolveImage(): AttachmentStore["resolveImage"] {
		return this.store.resolveImage?.bind(this.store);
	}

	bindDraft(sessionId: string): void {
		for (const upload of this.uploads.values()) {
			upload.sessionId ??= sessionId;
		}
	}

	discardDraft(): void {
		for (const upload of this.uploads.values()) {
			if (upload.sessionId === null && !upload.pins) this.discard(upload);
		}
	}

	async close(): Promise<void> {
		clearInterval(this.expirationTimer);
		this.closed = true;
		await this.queued;
		for (const upload of this.uploads.values()) this.discard(upload);
	}

	async begin(
		params: AttachmentUploadBeginParams,
		sessionId: string | null,
	): Promise<AttachmentUploadBeginResult> {
		const name = safeDisplayName(params.display_name);
		if (
			typeof params.upload_key !== "string" ||
			!UPLOAD_KEY.test(params.upload_key) ||
			typeof params.sha256 !== "string" ||
			!SHA256.test(params.sha256) ||
			!Number.isSafeInteger(params.byte_size) ||
			params.byte_size < 0 ||
			params.byte_size > this.limits.max_file_bytes ||
			params.byte_size > this.limits.max_message_bytes
		) {
			throw new AttachmentUploadError(
				"Invalid attachment upload metadata or size exceeds the limit",
			);
		}
		if (
			params.session_id !== undefined &&
			(typeof params.session_id !== "string" || params.session_id !== sessionId)
		) {
			throw new AttachmentUploadError("Attachment upload session is not bound");
		}
		return this.serial(() => {
			this.checkBinding(sessionId);
			const current = [...this.uploads.values()].filter(
				(entry) => entry.sessionId === sessionId,
			);
			const retry = current.find((entry) => entry.key === params.upload_key);
			if (retry) {
				if (
					retry.name !== name ||
					retry.size !== params.byte_size ||
					retry.sha256 !== params.sha256
				) {
					throw new AttachmentUploadError(
						"Attachment upload key conflicts with an earlier upload",
					);
				}
				this.touch(retry);
				return { upload_id: retry.id, offset: retry.offset };
			}
			const staged = [...this.uploads.values()].filter((entry) => entry.bytes);
			const inProgress = staged.filter((entry) => !entry.record).length;
			if (
				inProgress >= this.limits.max_concurrent_uploads ||
				staged.length >= this.limits.max_staged_uploads ||
				this.stagedBytes + params.byte_size > this.limits.max_staged_bytes ||
				processStagedBytes + params.byte_size > DEFAULT_LIMITS.max_staged_bytes
			) {
				throw new AttachmentUploadError(
					"Attachment upload staging is full; retry or cancel an unused upload",
				);
			}
			const id = createAttachmentId();
			const upload: Upload = {
				id,
				key: params.upload_key,
				sessionId,
				name,
				sha256: params.sha256,
				size: params.byte_size,
				offset: 0,
				bytes: Buffer.alloc(params.byte_size),
				expires: this.now() + this.limits.lease_ms,
				pins: 0,
			};
			this.uploads.set(id, upload);
			this.stagedBytes += upload.size;
			processStagedBytes += upload.size;
			return { upload_id: id, offset: 0 };
		});
	}

	async chunk(
		params: AttachmentUploadChunkParams,
		sessionId: string | null,
	): Promise<AttachmentUploadChunkResult> {
		if (
			!Number.isSafeInteger(params.offset) ||
			params.offset < 0 ||
			typeof params.data !== "string" ||
			!params.data ||
			params.data.length > Math.ceil(this.limits.max_chunk_bytes / 3) * 4
		) {
			throw new AttachmentUploadError(
				"Invalid attachment chunk offset or size",
			);
		}
		return this.serial(async () => {
			this.checkBinding(sessionId);
			const upload = this.getUpload(params.upload_id, sessionId);
			const bytes = Buffer.from(params.data, "base64");
			if (
				bytes.length > this.limits.max_chunk_bytes ||
				bytes.toString("base64") !== params.data
			) {
				throw new AttachmentUploadError(
					"Invalid attachment chunk encoding or size",
				);
			}
			const end = params.offset + bytes.length;
			if (params.offset < upload.offset && end <= upload.offset) {
				const previous = upload.bytes
					? upload.bytes.subarray(params.offset, end)
					: sessionId === null
						? undefined
						: await this.store.read(
								upload.id,
								sessionId,
								params.offset,
								bytes.length,
							);
				if (!previous || !bytes.equals(previous))
					throw new AttachmentUploadError(
						"Attachment chunk conflicts with previously acknowledged bytes",
					);
			} else {
				if (
					!upload.bytes ||
					upload.record ||
					params.offset !== upload.offset ||
					end > upload.size
				) {
					throw new AttachmentUploadError(
						"Attachment chunk is out of order or exceeds the declared size",
					);
				}
				bytes.copy(upload.bytes, params.offset);
				upload.offset = end;
			}
			this.touch(upload);
			return { offset: upload.offset };
		});
	}

	async finish(
		uploadId: string,
		sessionId: string | null,
	): Promise<AttachmentUploadFinishResult> {
		return this.serial(() => {
			this.checkBinding(sessionId);
			const upload = this.getUpload(uploadId, sessionId);
			if (!upload.record) {
				if (!upload.bytes || upload.offset !== upload.size)
					throw new AttachmentUploadError("Attachment upload is incomplete");
				try {
					if (digest(upload.bytes) !== upload.sha256)
						throw new AttachmentUploadError(
							"Attachment upload SHA-256 mismatch",
						);
					upload.record = this.inspect(upload, upload.bytes);
				} catch (error) {
					this.discard(upload);
					throw error;
				}
			}
			this.touch(upload);
			return { attachment_id: upload.id };
		});
	}

	async cancel(uploadId: string, sessionId: string | null): Promise<void> {
		if (typeof uploadId !== "string" || !isAttachmentId(uploadId))
			throw new AttachmentUploadError("Invalid attachment upload ID");
		return this.serial(() => {
			this.checkBinding(sessionId);
			const upload = this.uploads.get(uploadId);
			if (upload && upload.sessionId !== sessionId) {
				throw new AttachmentUploadError(
					"Attachment upload is unavailable in this session",
				);
			}
			if (upload?.bytes && !upload.pins) this.discard(upload);
		});
	}

	async resolveForAdmission(
		ids: readonly string[],
		sessionId: string,
		options?: { allowDraft?: boolean },
	): Promise<StoredAttachment[]> {
		return this.serial(async () => {
			const result: StoredAttachment[] = [];
			for (const id of ids) {
				const upload = this.eligibleUpload(
					id,
					sessionId,
					options?.allowDraft ?? false,
				);
				const record = upload?.record ?? (await this.lookup(id, sessionId));
				if (!record)
					throw new AttachmentUploadError(
						"Attachment unavailable in this session; re-upload to retry",
					);
				if (upload) this.touch(upload);
				result.push(record);
			}
			return result;
		});
	}

	async claim(
		ids: readonly string[],
		sessionId: string,
		options?: { allowDraft?: boolean },
	): Promise<void> {
		return this.serial(async () => {
			const pending: Upload[] = [];
			const entries: { record: StoredAttachment; bytes: Buffer }[] = [];
			for (const id of new Set(ids)) {
				const upload = this.eligibleUpload(
					id,
					sessionId,
					options?.allowDraft ?? false,
				);
				if (upload?.bytes && upload.record) {
					pending.push(upload);
					entries.push({ record: upload.record, bytes: upload.bytes });
				} else if (!(await this.lookup(id, sessionId))) {
					throw new AttachmentUploadError(
						"Attachment unavailable in this session; re-upload to retry",
					);
				}
			}
			if (!entries.length) return;
			try {
				await this.store.commit(sessionId, entries);
			} catch {
				throw new AttachmentUploadError(
					"Could not persist attachment originals; retry the submission",
				);
			}
			if (pending.some((upload) => upload.sessionId === null))
				this.bindDraft(sessionId);
			for (const upload of pending) {
				upload.sessionId = sessionId;
				this.releaseBytes(upload);
				this.touch(upload);
			}
			this.trimReceipts();
		});
	}

	async pin(ids: readonly string[], sessionId: string): Promise<() => void> {
		return this.serial(async () => {
			const pinned: Upload[] = [];
			for (const id of new Set(ids)) {
				const upload = this.eligibleUpload(id, sessionId, false);
				if (upload?.bytes && upload.record) pinned.push(upload);
				else if (!(await this.lookup(id, sessionId)))
					throw new AttachmentUploadError(
						"Attachment unavailable in this session; re-upload to retry",
					);
			}
			for (const upload of pinned) upload.pins++;
			return () => {
				for (const upload of pinned.splice(0)) {
					upload.pins--;
					this.touch(upload);
				}
			};
		});
	}

	async read(
		id: string,
		sessionId: string,
		offset: number,
		length: number,
	): Promise<Uint8Array> {
		try {
			if (
				!isAttachmentId(id) ||
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > DEFAULT_LIMITS.max_chunk_bytes
			) {
				throw new Error("Invalid attachment byte range");
			}
			const bytes = await this.store.read(id, sessionId, offset, length);
			if (bytes.length > length)
				throw new Error("Attachment adapter exceeded the requested byte range");
			return bytes;
		} catch {
			throw new AttachmentUploadError(
				"Attachment original is missing, corrupt or unavailable in this session",
			);
		}
	}

	private async lookup(
		id: string,
		sessionId: string,
	): Promise<StoredAttachment | null> {
		try {
			return isAttachmentId(id) ? await this.store.lookup(id, sessionId) : null;
		} catch {
			throw new AttachmentUploadError(
				"Attachment original is missing, corrupt or unavailable in this session",
			);
		}
	}

	private inspect(upload: Upload, bytes: Buffer): StoredAttachment {
		const visualType = detectImageAttachmentType(bytes);
		const ref = {
			attachment_id: upload.id,
			display_name: upload.name,
			byte_size: upload.size,
			sha256: upload.sha256,
			origin: "file" as const,
		};
		if (!visualType)
			return {
				ref: {
					...ref,
					media_type: isText(bytes) ? "text/plain" : "application/octet-stream",
				},
			};
		if (!this.store.resolveImage || bytes.length > this.limits.max_image_bytes)
			throw new AttachmentUploadError(
				"Copied image exceeds the size limit or the runtime has no image attachment adapter",
			);
		try {
			const dimensions = validateImageAttachment(bytes, visualType);
			return {
				ref: { ...ref, ...dimensions, media_type: visualType },
				imageRef: {
					...dimensions,
					artifact_id: `codelia-image-${randomUUID()}`,
					sha256: ref.sha256,
					byte_size: ref.byte_size,
					media_type: visualType,
				},
			};
		} catch {
			throw new AttachmentUploadError(
				"Copied image header is invalid or exceeds the dimension limit",
			);
		}
	}

	private getUpload(id: string, sessionId: string | null): Upload {
		const upload = this.uploads.get(id);
		if (!upload || upload.sessionId !== sessionId) {
			throw new AttachmentUploadError(
				"Attachment upload expired or is unavailable in this session",
			);
		}
		return upload;
	}

	private checkBinding(sessionId: string | null): void {
		if (this.getSessionId && sessionId !== this.getSessionId()) {
			throw new AttachmentUploadError(
				"Attachment upload session changed; retry in the owning session",
			);
		}
	}

	private eligibleUpload(
		id: string,
		sessionId: string,
		allowDraft: boolean,
	): Upload | undefined {
		const upload = this.uploads.get(id);
		if (!upload?.bytes || !upload.record) return undefined;
		const owner = upload.sessionId;
		return owner === sessionId || (owner === null && allowDraft)
			? upload
			: undefined;
	}

	private touch(upload: Upload): void {
		upload.expires = this.now() + this.limits.lease_ms;
	}

	private releaseBytes(upload: Upload): void {
		if (!upload.bytes) return;
		this.stagedBytes -= upload.size;
		processStagedBytes -= upload.size;
		upload.bytes = null;
	}

	private discard(upload: Upload): void {
		this.releaseBytes(upload);
		this.uploads.delete(upload.id);
	}

	private trimReceipts(): void {
		const claimed = [...this.uploads.values()].filter(
			(upload) => !upload.bytes,
		);
		const extra = claimed.length - DEFAULT_LIMITS.max_staged_uploads;
		if (extra <= 0) return;
		claimed.sort((a, b) => a.expires - b.expires);
		for (const upload of claimed.slice(0, extra)) this.discard(upload);
	}

	private sweep(): void {
		const now = this.now();
		for (const upload of this.uploads.values()) {
			if (!upload.pins && upload.expires <= now) this.discard(upload);
		}
	}

	private serial<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.queued.then(async () => {
			if (this.closed)
				throw new AttachmentUploadError("Attachment uploads are closed");
			this.sweep();
			this.operationActive = true;
			try {
				return await operation();
			} finally {
				this.operationActive = false;
			}
		});
		this.queued = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
