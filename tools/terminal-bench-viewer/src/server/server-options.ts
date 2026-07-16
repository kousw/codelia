export const DEFAULT_VIEWER_HOSTNAME = "127.0.0.1";

export const resolveViewerHostname = (
	value = process.env.CODELIA_TERMINAL_BENCH_VIEWER_HOST,
): string => value?.trim() || DEFAULT_VIEWER_HOSTNAME;
