const envTruthy = (value?: string): boolean => {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
};

export const isDebugEnabled = (): boolean =>
	envTruthy(process.env.CODELIA_DEBUG);

export const log = (message: string): void => {
	process.stderr.write(`[runtime] ${message}\n`);
};

export const debugLog = (message: string): void => {
	if (!isDebugEnabled()) return;
	log(message);
};
