import { promises as fs } from "node:fs";
import path from "node:path";
import { getDebugDir, hasDebugTopic } from "@codelia/logger";

export type ProviderLogSettings = {
	enabled: boolean;
	dumpDir?: string;
};

export type ProviderLogDirection = "request" | "response";

export const getProviderLogSettings = (): ProviderLogSettings => {
	const enabled = hasDebugTopic("provider-log");
	const dumpDirEnv = getDebugDir();
	const dumpDir = enabled
		? dumpDirEnv && dumpDirEnv.length > 0
			? dumpDirEnv
			: path.resolve(process.cwd(), "tmp")
		: undefined;
	return { enabled, dumpDir };
};

export const safeJsonStringify = (value: unknown, space?: number): string => {
	const seen = new WeakSet<object>();
	return (
		JSON.stringify(
			value,
			(_key, currentValue) => {
				if (typeof currentValue === "bigint") {
					return currentValue.toString();
				}
				if (typeof currentValue === "object" && currentValue !== null) {
					if (seen.has(currentValue)) {
						return "[Circular]";
					}
					seen.add(currentValue);
				}
				return currentValue;
			},
			space,
		) ?? "null"
	);
};

export const sharedPrefixChars = (a: string, b: string): number => {
	const min = Math.min(a.length, b.length);
	let index = 0;
	while (index < min && a.charCodeAt(index) === b.charCodeAt(index)) {
		index += 1;
	}
	return index;
};

export const writeProviderLogDump = async (
	settings: ProviderLogSettings,
	provider: string,
	seq: number,
	direction: ProviderLogDirection,
	payload: unknown,
): Promise<void> => {
	if (!settings.dumpDir) {
		return;
	}
	await fs.mkdir(settings.dumpDir, { recursive: true });
	const iso = new Date().toISOString().replace(/[:.]/g, "-");
	const fileName = `${iso}_${process.pid}_${provider}_${seq}_${direction}.json`;
	const filePath = path.resolve(settings.dumpDir, fileName);
	const prettyPayload = safeJsonStringify(payload, 2);
	await fs.writeFile(filePath, `${prettyPayload}\n`, "utf8");
};
