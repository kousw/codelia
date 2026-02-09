import path from "node:path";
import { fileURLToPath } from "node:url";

const resolvePromptPath = (): string => {
	if (typeof __filename === "string") {
		return path.resolve(path.dirname(__filename), "../prompts/system.md");
	}
	if (typeof import.meta !== "undefined" && import.meta.url) {
		return fileURLToPath(new URL("../prompts/system.md", import.meta.url));
	}
	return path.resolve("prompts/system.md");
};

const promptPath = resolvePromptPath();

export const getDefaultSystemPromptPath = (): string => promptPath;
