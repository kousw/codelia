import { type McpAuthFile, McpAuthStore } from "@codelia/storage";

const authStore = new McpAuthStore();

export const readMcpAuth = async (): Promise<McpAuthFile> => {
	return authStore.load();
};

export const writeMcpAuth = async (auth: McpAuthFile): Promise<void> => {
	await authStore.save(auth);
};
