import { type McpAuthFile, McpAuthStore } from "@codelia/storage";

export const readMcpAuth = async (): Promise<McpAuthFile> => {
	return new McpAuthStore().load();
};

export const writeMcpAuth = async (auth: McpAuthFile): Promise<void> => {
	await new McpAuthStore().save(auth);
};

export const updateMcpAuth = async <T>(
	mutate: (auth: McpAuthFile) => T | Promise<T>,
): Promise<T> => {
	return new McpAuthStore().update(mutate);
};
