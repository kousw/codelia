export type TaskProcessSignal = "SIGTERM" | "SIGKILL";

export type TaskProcessController = {
	isProcessAlive: (pid: number) => Promise<boolean>;
	terminateProcess: (pid: number, signal: TaskProcessSignal) => Promise<void>;
	terminateProcessGroup: (
		pgid: number,
		signal: TaskProcessSignal,
	) => Promise<void>;
};

const isNodeErrno = (error: unknown): error is NodeJS.ErrnoException =>
	error instanceof Error;

export const defaultTaskProcessController: TaskProcessController = {
	async isProcessAlive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			if (isNodeErrno(error) && error.code === "EPERM") {
				return true;
			}
			return false;
		}
	},
	async terminateProcess(pid, signal) {
		process.kill(pid, signal);
	},
	async terminateProcessGroup(pgid, signal) {
		if (process.platform === "win32") {
			process.kill(pgid, signal);
			return;
		}
		process.kill(-pgid, signal);
	},
};
