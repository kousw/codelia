import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
/** Identity guards PID reuse during recovery. Failure is unknown, never permission to kill. */
export const getProcessIdentity = async (
	pid: number,
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
		return new Promise((resolve) => {
			execFile(
				"/bin/ps",
				["-p", String(pid), "-o", "lstart="],
				{ timeout: 2000 },
				(error, stdout) =>
					resolve(error || !stdout.trim() ? null : `${pid}:${stdout.trim()}`),
			);
		});
	return null; // No verified Windows process identity backend yet.
};
