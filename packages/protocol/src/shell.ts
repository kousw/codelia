export type ShellExecParams = {
	command: string;
	timeout_seconds?: number;
	cwd?: string;
};

export type ShellExecResult = {
	command_preview: string;
	exit_code: number | null;
	signal?: string | null;
	stdout: string;
	stderr: string;
	truncated: {
		stdout: boolean;
		stderr: boolean;
		combined: boolean;
	};
	duration_ms: number;
	stdout_cache_id?: string;
	stderr_cache_id?: string;
};
