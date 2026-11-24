import { RPC_ERROR_CODE, type RpcError } from "@codelia/protocol";
import {
	DEFAULT_TIMEOUT_SECONDS,
	MAX_EXECUTION_TIMEOUT_SECONDS,
	MAX_TIMEOUT_SECONDS,
} from "../tools/bash-utils";

/**
 * Execution timeout for an RPC shell launch (`shell.start`, `task.spawn`).
 * Foreground launches are clamped; background launches reject values beyond
 * the Node timer range and run without a timer when the value is omitted.
 */
export const resolveRpcShellTimeoutSeconds = (
	requestedTimeout: number | undefined,
	background: boolean,
): number | undefined | { error: RpcError } => {
	if (requestedTimeout !== undefined) {
		if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
			return {
				error: {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "timeout_seconds must be a positive number",
				},
			};
		}
		if (!background) {
			return Math.max(
				1,
				Math.min(Math.trunc(requestedTimeout), MAX_TIMEOUT_SECONDS),
			);
		}
		if (requestedTimeout > MAX_EXECUTION_TIMEOUT_SECONDS) {
			return {
				error: {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: `background timeout_seconds must be ${MAX_EXECUTION_TIMEOUT_SECONDS} or less; omit timeout_seconds to run without an execution timer`,
				},
			};
		}
		return Math.max(1, Math.trunc(requestedTimeout));
	}
	return background ? undefined : DEFAULT_TIMEOUT_SECONDS;
};
