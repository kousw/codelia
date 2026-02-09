import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { debugLog } from "../logger";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import {
	DEFAULT_TIMEOUT_SECONDS,
	type ExecLikeError,
	formatCommandFailure,
	MAX_OUTPUT_BYTES,
	MAX_TIMEOUT_SECONDS,
	runShellCommand,
	summarizeCommand,
} from "./bash-utils";

export const createBashTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "bash",
		description:
			"Run a shell command in the sandbox working directory and return output.",
		input: z.object({
			command: z
				.string()
				.describe("Shell command to execute in the current workspace."),
			timeout: z
				.number()
				.int()
				.positive()
				.max(MAX_TIMEOUT_SECONDS)
				.optional()
				.describe(
					`Timeout in seconds (not milliseconds). Optional, defaults to ${DEFAULT_TIMEOUT_SECONDS}. Max ${MAX_TIMEOUT_SECONDS}.`,
				),
		}),
		execute: async (input, ctx) => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			const requestedTimeout = input.timeout ?? DEFAULT_TIMEOUT_SECONDS;
			const timeoutSeconds = Math.max(
				1,
				Math.min(requestedTimeout, MAX_TIMEOUT_SECONDS),
			);
			const startedAt = Date.now();
			const commandSummary = summarizeCommand(input.command);
			debugLog(
				`bash.start cwd=${sandbox.workingDir} timeout_s=${timeoutSeconds} requested_timeout_s=${requestedTimeout} command="${commandSummary}"`,
			);
			try {
				const { stdout, stderr } = await runShellCommand(input.command, {
					cwd: sandbox.workingDir,
					timeoutMs: timeoutSeconds * 1000,
					maxOutputBytes: MAX_OUTPUT_BYTES,
					signal: ctx.signal,
				});
				const output = `${stdout}${stderr}`.trim();
				debugLog(
					`bash.done duration_ms=${Date.now() - startedAt} output_bytes=${Buffer.byteLength(output, "utf8")}`,
				);
				return output || "(no output)";
			} catch (error) {
				if (ctx.signal?.aborted) {
					debugLog(`bash.aborted duration_ms=${Date.now() - startedAt}`);
					return "Command cancelled";
				}
				const execError =
					error instanceof Error ? (error as ExecLikeError) : undefined;
				const elapsedMs = Date.now() - startedAt;
				const timedOut =
					execError?.code === "ETIMEDOUT" ||
					(execError?.killed === true &&
						execError.signal === "SIGTERM" &&
						elapsedMs >= timeoutSeconds * 1000);
				if (timedOut) {
					debugLog(
						`bash.timeout duration_ms=${elapsedMs} timeout_s=${timeoutSeconds}`,
					);
					const detail = execError ? formatCommandFailure(execError) : "";
					return detail
						? `Command timed out after ${timeoutSeconds}s\n${detail}`
						: `Command timed out after ${timeoutSeconds}s`;
				}
				const message = execError
					? formatCommandFailure(execError)
					: `Error: ${String(error)}`;
				debugLog(`bash.error duration_ms=${elapsedMs} message=${message}`);
				return message;
			}
		},
	});
