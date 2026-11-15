import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
/** Identity guards PID reuse. Failure is unknown, never permission to kill or remove a live-writer marker. */
export const getProcessIdentity = async (
	pid: number,
	options: { canonicalEnvironment?: boolean } = {},
): Promise<string | null> => {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	if (process.platform === "linux") {
		try {
			const [stat, boot] = await Promise.all([
				fs.readFile(`/proc/${pid}/stat`, "utf8"),
				fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
			]);
			return `${boot.trim()}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
		} catch {
			return null;
		} // Process may already have exited; caller must not assume identity.
	}
	if (process.platform === "darwin")
		return new Promise<string | null>((resolve) => {
			execFile(
				"/bin/ps",
				["-p", String(pid), "-o", "lstart="],
				{
					timeout: 2000,
					// Preserve existing task recovery identities unless explicitly requested.
					env: options.canonicalEnvironment
						? { ...process.env, LC_ALL: "C", TZ: "UTC" }
						: process.env,
				},
				(error, stdout) =>
					resolve(error || !stdout.trim() ? null : `${pid}:${stdout.trim()}`),
			);
		}).catch(() => null); // Some runtimes throw synchronously when spawning is denied.
	return null; // No verified Windows process identity backend yet.
};
