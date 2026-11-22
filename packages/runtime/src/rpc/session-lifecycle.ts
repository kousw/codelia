import type { SessionStateStore } from "@codelia/core";
import { RPC_ERROR_CODE, type SessionUpdateResult } from "@codelia/protocol";
import type { RuntimeState } from "../runtime-state";
import { parseRequestParams, sendRequestResult } from "./protocol";
import { sendError } from "./transport";

export const createSessionUpdateHandler =
	(options: {
		sessions: SessionStateStore;
		state: RuntimeState;
		log: (message: string) => void;
		cleanup?: (sessionId: string) => Promise<void>;
	}) =>
	async (id: string, raw: unknown): Promise<void> => {
		if (!options.sessions.updateMetadata) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "Session lifecycle updates are unavailable",
			});
			return;
		}
		const parsed = parseRequestParams("session.update", raw);
		if (!parsed.ok) return sendError(id, parsed.error);
		const params = parsed.params;
		if (
			!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(params.session_id) ||
			(params.pinned === undefined && params.archived === undefined)
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "Expected session_id and a boolean pinned or archived update",
			});
			return;
		}
		if (
			params.archived &&
			options.state.activeRunId &&
			options.state.sessionId === params.session_id
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "Wait for the active run before archiving this session",
			});
			return;
		}
		try {
			const session = await options.sessions.updateMetadata(params.session_id, {
				pinned: params.pinned,
				archived: params.archived,
			});
			if (options.cleanup && !session.pinned) {
				try {
					await options.cleanup(params.session_id);
				} catch (error) {
					options.log(`session log cleanup failed: ${String(error)}`);
				}
			}
			const result: SessionUpdateResult = { session };
			sendRequestResult("session.update", id, result);
		} catch (error) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: `Session update failed: ${String(error)}`,
			});
		}
	};
