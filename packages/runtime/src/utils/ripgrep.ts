import { spawn } from "node:child_process";

const MAX_STDERR_BYTES = 32 * 1024;
const RG_HIDDEN_ARGS = ["--hidden", "--no-ignore"] as const;
const RG_EXCLUDE_GIT_ARGS = [
	"--glob",
	"!.git",
	"--glob",
	"!.git/**",
	"--glob",
	"!**/.git/**",
] as const;

export const RIPGREP_FALLBACK_REASON =
	"ripgrep is unavailable in this runtime; falling back to the built-in scanner";

export const buildRipgrepBaseArgs = (): string[] => [
	...RG_HIDDEN_ARGS,
	...RG_EXCLUDE_GIT_ARGS,
];

export type RipgrepLineRunResult =
	| {
			status: "ok";
			exitCode: number | null;
			stderr: string;
			terminatedEarly: boolean;
		}
	| {
			status: "missing";
			error: string;
		}
	| {
			status: "error";
			error: string;
		};

export type RunRipgrepLinesOptions = {
	cwd: string;
	onLine: (line: string) => boolean;
	env?: NodeJS.ProcessEnv;
};

export type RipgrepLineRunner = (
	args: string[],
	options: RunRipgrepLinesOptions,
) => Promise<RipgrepLineRunResult>;

const appendBounded = (value: string, chunk: string, maxBytes: number): string => {
	const next = `${value}${chunk}`;
	if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
	let bytes = 0;
	let out = "";
	for (const ch of next) {
		const size = Buffer.byteLength(ch, "utf8");
		if (bytes + size > maxBytes) break;
		out += ch;
		bytes += size;
	}
	return out;
};

export const runRipgrepLines: RipgrepLineRunner = (
	args: string[],
	options: RunRipgrepLinesOptions,
): Promise<RipgrepLineRunResult> =>
	new Promise((resolve) => {
		let settled = false;
		let terminatedEarly = false;
		let stderr = "";
		let pending = "";

		const finish = (result: RipgrepLineRunResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const child = spawn("rg", args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const handleLine = (line: string): boolean => {
			try {
				return options.onLine(line);
			} catch (error) {
				finish({
					status: "error",
					error: `Failed to process ripgrep output: ${String(error)}`,
				});
				child.kill("SIGTERM");
				return false;
			}
		};

		child.on("error", (error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				finish({
					status: "missing",
					error: RIPGREP_FALLBACK_REASON,
				});
				return;
			}
			finish({
				status: "error",
				error: `Failed to start ripgrep: ${String(error)}`,
			});
		});

		child.stdout.on("data", (chunk: Buffer) => {
			if (settled || terminatedEarly) return;
			pending += chunk.toString("utf8");
			let newlineIndex = pending.indexOf("\n");
			while (newlineIndex >= 0) {
				const rawLine = pending.slice(0, newlineIndex);
				pending = pending.slice(newlineIndex + 1);
				const keepGoing = handleLine(rawLine.replace(/\r$/, ""));
				if (!keepGoing) {
					if (!settled) {
						terminatedEarly = true;
						child.kill("SIGTERM");
					}
					return;
				}
				newlineIndex = pending.indexOf("\n");
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk.toString("utf8"), MAX_STDERR_BYTES);
		});

		child.on("close", (code) => {
			if (settled) return;
			if (!terminatedEarly && pending.length > 0) {
				const keepGoing = handleLine(pending.replace(/\r$/, ""));
				if (!keepGoing) {
					return;
				}
			}
			finish({
				status: "ok",
				exitCode: code,
				stderr,
				terminatedEarly,
			});
		});
	});
