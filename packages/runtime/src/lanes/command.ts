import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 512 * 1024;

const truncate = (value: string): string => {
	if (value.length <= 8_000) return value;
	return `${value.slice(0, 8_000)}...[truncated]`;
};

export type CommandRunner = (
	command: string,
	args: string[],
	options?: {
		cwd?: string;
		timeoutMs?: number;
	},
) => Promise<{ stdout: string; stderr: string }>;

export const runCommand: CommandRunner = async (
	command,
	args,
	options = {},
) => {
	const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let done = false;

		const finish = (fn: () => void): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			fn();
		};

		const consume = (chunk: Buffer, kind: "stdout" | "stderr"): void => {
			const text = chunk.toString("utf8");
			bytes += Buffer.byteLength(text, "utf8");
			if (bytes > MAX_CAPTURE_BYTES) {
				finish(() =>
					reject(
						new Error(
							`${command} output exceeded ${MAX_CAPTURE_BYTES} bytes while running ${args.join(" ")}`,
						),
					),
				);
				try {
					child.kill("SIGTERM");
				} catch {}
				return;
			}
			if (kind === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
		child.on("error", (error) => {
			finish(() => reject(error));
		});
		child.on("close", (code) => {
			if (code === 0) {
				finish(() => resolve({ stdout, stderr }));
				return;
			}
			const detail = `${stderr}\n${stdout}`.trim();
			const message = detail
				? `${command} ${args.join(" ")} failed (exit ${String(code)}): ${truncate(detail)}`
				: `${command} ${args.join(" ")} failed (exit ${String(code)})`;
			finish(() => reject(new Error(message)));
		});

		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {}
			finish(() =>
				reject(
					new Error(
						`${command} ${args.join(" ")} timed out after ${Math.floor(timeoutMs / 1000)}s`,
					),
				),
			);
		}, timeoutMs);
	});
};
