import type {
	AttachmentUploadBeginParams,
	AttachmentUploadCancelParams,
	AttachmentUploadCancelResult,
	AttachmentUploadChunkParams,
	AttachmentUploadFinishParams,
} from "@codelia/protocol";
import { RPC_ERROR_CODE } from "@codelia/protocol";
import { AttachmentUploadError } from "../attachments/service";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendResult } from "./transport";

type Method = `attachment.upload.${"begin" | "chunk" | "finish" | "cancel"}`;

export async function handleAttachmentUpload(
	state: RuntimeState,
	id: string,
	method: Method,
	params: unknown,
): Promise<void> {
	const attachments = state.attachments;
	try {
		if (!attachments)
			throw new AttachmentUploadError("Attachment uploads are disabled");
		if (!params || typeof params !== "object" || Array.isArray(params))
			throw new AttachmentUploadError(
				"Attachment upload parameters are required",
			);
		switch (method) {
			case "attachment.upload.begin":
				return sendResult(
					id,
					await attachments.begin(
						params as AttachmentUploadBeginParams,
						state.sessionId,
					),
				);
			case "attachment.upload.chunk":
				return sendResult(
					id,
					await attachments.chunk(
						params as AttachmentUploadChunkParams,
						state.sessionId,
					),
				);
			case "attachment.upload.finish":
				return sendResult(
					id,
					await attachments.finish(
						(params as AttachmentUploadFinishParams).upload_id,
						state.sessionId,
					),
				);
			case "attachment.upload.cancel":
				await attachments.cancel(
					(params as AttachmentUploadCancelParams).upload_id,
					state.sessionId,
				);
				return sendResult(id, {
					ok: true,
				} satisfies AttachmentUploadCancelResult);
		}
	} catch (error) {
		if (!(error instanceof AttachmentUploadError)) throw error;
		sendError(id, {
			code: RPC_ERROR_CODE.INVALID_PARAMS,
			message: error.message,
		});
	}
}
