export type StorageLayout = "home" | "xdg";

export type StoragePaths = {
	root: string;
	configDir: string;
	configFile: string;
	credentialsDir: string;
	authFile: string;
	mcpAuthFile: string;
	legacyAuthFile: string;
	legacyMcpAuthFile: string;
	authStateFile: string;
	projectsFile: string;
	cacheDir: string;
	toolOutputCacheDir: string;
	sessionsDir: string;
	logsDir: string;
};

export type ResolveStorageOptions = {
	layout?: StorageLayout;
	rootOverride?: string;
};

export interface StoragePathService {
	resolvePaths(options?: ResolveStorageOptions): StoragePaths;
}
