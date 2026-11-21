export type {
	ResolveStorageOptions,
	StorageLayout,
	StoragePathService,
	StoragePaths,
} from "@codelia/core";
export { type AtomicWriteOptions, writeFileAtomic } from "./atomic-file";
export {
	type AttachmentStore,
	createAttachmentId,
	FileAttachmentStore,
	isAttachmentId,
	type StoredAttachment,
} from "./attachments";
export {
	type AuthLockOptions,
	authLockPathFor,
	DEFAULT_AUTH_LOCK_TIMEOUT_MS,
	DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
	withAuthStoreLock,
} from "./auth-lock";
export {
	type ApiKeyCredential,
	AUTH_VERSION_V1,
	AUTH_VERSION_V2,
	type AuthFile,
	type AuthFileV2,
	type OAuthTokens,
	type ProviderAuth,
	type ProviderAuthV2,
	parseAuthDocument,
	providerAuthStoreAdapter,
} from "./auth-schema";
export {
	type AuthStorageFallbackReason,
	type ConfiguredAuthStorageMode,
	type CredentialConflictResolutionStrategy,
	type CredentialStoreRuntimeOptions,
	clearStoreAcrossAllLocationsUnlocked,
	coordinateCredentialBackend,
	coordinateCredentialBackendUnlocked,
	inspectCredentialStorageStatus,
	type ResolvedCredentialBackend,
	resolveConfiguredAuthStorageMode,
	resolveCredentialConflict,
	type StoreAdapter,
} from "./credential-backend";
export {
	type AuthStorageState,
	type CredentialBackendKind,
	CredentialConflictError,
	canonicalJsonEqual,
	canonicalJsonStringify,
	type PendingCleanupState,
	parseAuthStorageState,
	readAuthStorageState,
	readAuthStorageStateSync,
	runTwoPhaseMigration,
	type StoreMigrationSlot,
	type StoreMigrationStatus,
	writeAuthStorageState,
} from "./credential-migration";
export { ImageArtifactStore } from "./image-artifacts";
export {
	detectImageAttachmentType,
	validateImageAttachment,
} from "./image-attachment";
export { IMAGE_MAX_BYTES, validateImagePng } from "./image-png";
export {
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	defaultUntrustedHelperRoots,
	type KeychainClient,
	KeychainError,
	type KeychainProbeResult,
	keychainAccountForConfigDir,
	MacOsKeychainClient,
	type ResolveHelperOptions,
	resolveMacOsCredentialHelper,
	resolveTrustedMacOsCredentialHelper,
	type TrustedCredentialHelper,
} from "./macos-keychain";
export {
	buildMcpAuthBinding,
	canonicalizeMcpUri,
	deriveMcpIssuer,
	MCP_AUTH_VERSION,
	type McpAuthFile,
	McpAuthStore,
	type McpAuthStoreOptions,
	type McpBoundServerAuth,
	type McpOAuthTokens,
	type McpServerAuthBinding,
	mcpAuthBindingMatches,
	mcpAuthStoreAdapter,
	parseMcpAuthDocument,
} from "./mcp-auth-store";
export { ensureStorageDirs, resolveStoragePaths } from "./paths";
export { getProcessIdentity } from "./process-identity";
export { type ProjectsPolicyFile, ProjectsPolicyStore } from "./projects-store";
export { RunEventStoreFactoryImpl } from "./run-event-store";
export { readRunLogLines, resolveRunLogPath } from "./run-log-reader";
export {
	cleanupRunLogs,
	RUN_LOG_RETENTION_MS,
	type RunLogCleanupResult,
} from "./run-log-retention";
export { StoragePathServiceImpl } from "./service";
export {
	type GoalRunClaim,
	SessionGoalStore,
	type StoredSessionGoal,
} from "./session-goals";
export {
	resolveIndexedRunLog,
	type SessionRunEntry,
	type SessionRunRecorder,
	scanSessionRunLogs,
} from "./session-run-index";
export { SessionStateStoreImpl } from "./session-state";
export { SessionStoreWriterImpl } from "./session-store";
export {
	type TaskArtifact,
	type TaskKind,
	type TaskRecord,
	TaskRegistryStore,
	type TaskResult,
	type TaskState,
	type TaskTruncatedOutput,
	type TaskWorkspaceMode,
} from "./task-registry";
export { ToolOutputCacheStoreImpl } from "./tool-output-cache";
export {
	enforceWindowsOwnerOnlyDacl,
	ensureCredentialsDirectory,
	resolveWindowsSystem32Dir,
	verifyWindowsCredentialFileAcl,
	verifyWindowsCredentialFileAclSync,
	type WindowsAclRunner,
	type WindowsAclRunnerOptions,
} from "./windows-acl";
