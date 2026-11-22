import { RPC_ERROR_CODE } from "@codelia/protocol";
import { AttachmentUploadError } from "../attachments/service";
import type { RuntimeState } from "../runtime-state";
import { parseRequestParams, sendRequestResult } from "./protocol";
import { sendError } from "./transport";

type Method = `attachment.upload.${"begin" | "chunk" | "finish" | "cancel"}`;

export async function handleAttachmentUpload(
	state: RuntimeState,
	id: string,
	method: Method,
	raw: unknown,
): Promise<void> {
	const attachments = state.attachments;
	try {
		if (!attachments)
			throw new AttachmentUploadError("Attachment uploads are disabled");
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new AttachmentUploadError(
				"Attachment upload parameters are required",
			);
		switch (method) {
			case "attachment.upload.begin": {
				const parsed = parseRequestParams(method, raw);
				if (!parsed.ok) return sendError(id, parsed.error);
				return sendRequestResult(
					method,
					id,
					await attachments.begin(parsed.params, state.sessionId),
				);
			}
			case "attachment.upload.chunk": {
				const parsed = parseRequestParams(method, raw);
				if (!parsed.ok) return sendError(id, parsed.error);
				return sendRequestResult(
					method,
					id,
					await attachments.chunk(parsed.params, state.sessionId),
				);
			}
			case "attachment.upload.finish": {
				const parsed = parseRequestParams(method, raw);
				if (!parsed.ok) return sendError(id, parsed.error);
				return sendRequestResult(
					method,
					id,
					await attachments.finish(parsed.params.upload_id, state.sessionId),
				);
			}
			case "attachment.upload.cancel": {
				const parsed = parseRequestParams(method, raw);
				if (!parsed.ok) return sendError(id, parsed.error);
				await attachments.cancel(parsed.params.upload_id, state.sessionId);
				return sendRequestResult(method, id, { ok: true });
			}
		}
	} catch (error) {
		if (!(error instanceof AttachmentUploadError)) throw error;
		sendError(id, {
			code: RPC_ERROR_CODE.INVALID_PARAMS,
			message: error.message,
		});
	}
}
