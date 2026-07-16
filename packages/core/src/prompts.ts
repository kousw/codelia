import path from "node:path";
import { fileURLToPath } from "node:url";

const resolvePromptPath = (): string => {
	const moduleLocation = import.meta.url;
	const moduleFilename = moduleLocation.startsWith("file:")
		? fileURLToPath(moduleLocation)
		: moduleLocation;
	return path.resolve(path.dirname(moduleFilename), "../prompts/system.md");
};

const promptPath = resolvePromptPath();

export const getDefaultSystemPromptPath = (): string => promptPath;
