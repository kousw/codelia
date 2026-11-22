import { promises as fs, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-file";
import {
	verifyWindowsCredentialFileAcl,
	verifyWindowsCredentialFileAclSync,
} from "./windows-acl";

export type CredentialBackendKind = "file" | "keyring";
export type PendingCleanupSource = CredentialBackendKind | "legacy_file";
export type StoreMigrationStatus = "pending" | "verified";

export type PendingCleanupState = {
	source_backend: PendingCleanupSource;
	auth: boolean;
	mcp_auth: boolean;
};

export type AuthStorageState =
	| {
			version: 1;
			status: "steady";
			active_backend: CredentialBackendKind;
			mcp_reauth_required?: string[];
	  }
	| {
			version: 1;
			status: "migrating";
			active_backend: CredentialBackendKind;
			target_backend: CredentialBackendKind;
			stores: {
				auth: StoreMigrationStatus;
				mcp_auth: StoreMigrationStatus;
			};
			cleanup_pending?: PendingCleanupState;
			mcp_reauth_required?: string[];
	  };

export class CredentialConflictError extends Error {
	readonly code = "credential_storage_conflict";
	readonly store: "auth" | "mcp_auth";

	constructor(store: "auth" | "mcp_auth", detail?: string) {
		super(
			detail ??
				`Credential storage conflict detected for '${store}': both source and destination contain different credentials. Resolve the conflict before continuing.`,
		);
		this.name = "CredentialConflictError";
		this.store = store;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalizeValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(canonicalizeValue);
	}
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const entry = value[key];
			if (entry !== undefined) {
				sorted[key] = canonicalizeValue(entry);
			}
		}
		return sorted;
	}
	return value;
};

export const canonicalJsonStringify = (value: unknown): string =>
	JSON.stringify(canonicalizeValue(value));

export const canonicalJsonEqual = (left: unknown, right: unknown): boolean =>
	canonicalJsonStringify(left) === canonicalJsonStringify(right);

export const parseAuthStorageState = (text: string): AuthStorageState => {
	const parsed = JSON.parse(text) as unknown;
	if (!isRecord(parsed) || parsed.version !== 1) {
		throw new Error("storage-state.json has unsupported version");
	}
	const active = parsed.active_backend;
	if (active !== "file" && active !== "keyring") {
		throw new Error("storage-state.json has invalid active_backend");
	}
	if (
		parsed.mcp_reauth_required !== undefined &&
		(!Array.isArray(parsed.mcp_reauth_required) ||
			!parsed.mcp_reauth_required.every((item) => typeof item === "string"))
	) {
		throw new Error("storage-state.json has invalid mcp_reauth_required");
	}
	const mcpReauth = parsed.mcp_reauth_required as string[] | undefined;

	if (parsed.status === "steady") {
		return {
			version: 1,
			status: "steady",
			active_backend: active,
			...(mcpReauth?.length ? { mcp_reauth_required: mcpReauth } : {}),
		};
	}
	if (parsed.status === "migrating") {
		const target = parsed.target_backend;
		const stores = isRecord(parsed.stores) ? parsed.stores : null;
		const authStatus = stores?.auth;
		const mcpStatus = stores?.mcp_auth;
		if (
			(target !== "file" && target !== "keyring") ||
			(authStatus !== "pending" && authStatus !== "verified") ||
			(mcpStatus !== "pending" && mcpStatus !== "verified")
		) {
			throw new Error("storage-state.json has invalid migrating state");
		}
		let cleanupPending: PendingCleanupState | undefined;
		if (parsed.cleanup_pending !== undefined) {
			if (!isRecord(parsed.cleanup_pending)) {
				throw new Error("storage-state.json has invalid cleanup_pending");
			}
			const sourceBackend = parsed.cleanup_pending.source_backend;
			const authFlag = parsed.cleanup_pending.auth;
			const mcpFlag = parsed.cleanup_pending.mcp_auth;
			if (
				(sourceBackend !== "file" &&
					sourceBackend !== "legacy_file" &&
					sourceBackend !== "keyring") ||
				typeof authFlag !== "boolean" ||
				typeof mcpFlag !== "boolean"
			) {
				throw new Error("storage-state.json has invalid cleanup_pending");
			}
			cleanupPending = {
				source_backend: sourceBackend,
				auth: authFlag,
				mcp_auth: mcpFlag,
			};
		}
		return {
			version: 1,
			status: "migrating",
			active_backend: active,
			target_backend: target,
			stores: { auth: authStatus, mcp_auth: mcpStatus },
			...(cleanupPending ? { cleanup_pending: cleanupPending } : {}),
			...(mcpReauth?.length ? { mcp_reauth_required: mcpReauth } : {}),
		};
	}
	throw new Error("storage-state.json has invalid status");
};

export const readAuthStorageState = async (
	stateFile: string,
): Promise<AuthStorageState | null> => {
	if (!(await verifyWindowsCredentialFileAcl(stateFile))) return null;
	let text: string;
	try {
		text = await fs.readFile(stateFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
	return parseAuthStorageState(text);
};

/**
 * Synchronous read of `storage-state.json` for approval-time checks.
 * Returns `null` ONLY on ENOENT; throws on corrupt or unreadable markers.
 */
export const readAuthStorageStateSync = (
	stateFile: string,
): AuthStorageState | null => {
	if (!verifyWindowsCredentialFileAclSync(stateFile)) return null;
	let text: string;
	try {
		text = readFileSync(stateFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
	return parseAuthStorageState(text);
};

export const writeAuthStorageState = async (
	stateFile: string,
	state: AuthStorageState,
): Promise<void> => {
	await writeFileAtomic(stateFile, JSON.stringify(state, null, 2), {
		mode: 0o600,
	});
};

export type StoreMigrationSlot<T> = {
	name: "auth" | "mcp_auth";
	readSource: () => Promise<{
		present: boolean;
		normalized: T;
		nonEmpty: boolean;
		extraWarnings?: string[];
	}>;
	readDest: () => Promise<{
		present: boolean;
		normalized: T;
		nonEmpty: boolean;
	}>;
	writeDest: (normalized: T) => Promise<void>;
	verifyDest: (expected: T) => Promise<boolean>;
	cleanupSource: () => Promise<void>;
};

/**
 * Universal pre-write conflict detection and two-phase migration (spec §9.6).
 * Must be called while holding the interprocess auth lock.
 */
export const runTwoPhaseMigration = async <TAuth, TMcp>(options: {
	stateFile: string;
	fromBackend: CredentialBackendKind;
	toBackend: CredentialBackendKind;
	cleanupSourceKind?: PendingCleanupSource;
	authSlot: StoreMigrationSlot<TAuth>;
	mcpSlot: StoreMigrationSlot<TMcp>;
	existingMcpReauth?: string[];
	/**
	 * When true (or when `fromBackend !== toBackend`), commit steady state on
	 * `toBackend` even if both source stores are absent/empty.
	 */
	commitSteadyIfEmpty?: boolean;
}): Promise<{ migrated: boolean; mcpReauthRequired: string[] }> => {
	const [authSrc, authDst, mcpSrc, mcpDst] = await Promise.all([
		options.authSlot.readSource(),
		options.authSlot.readDest(),
		options.mcpSlot.readSource(),
		options.mcpSlot.readDest(),
	]);

	// Step 1: Pre-write conflict detection across ALL stores BEFORE any write.
	const evaluate = <T>(
		name: "auth" | "mcp_auth",
		src: { present: boolean; normalized: T; nonEmpty: boolean },
		dst: { present: boolean; normalized: T; nonEmpty: boolean },
	): "none" | "copy" | "recover" => {
		if (!src.present) return "none";
		if (src.nonEmpty && dst.nonEmpty) {
			if (canonicalJsonEqual(src.normalized, dst.normalized)) {
				return "recover";
			}
			throw new CredentialConflictError(name);
		}
		if (!src.nonEmpty && dst.nonEmpty) {
			// Source is empty (e.g. legacy v1 MCP with only unbound entries dropped)
			// while destination already holds valid v2 data: do not overwrite dst.
			return "recover";
		}
		if (dst.present && canonicalJsonEqual(src.normalized, dst.normalized)) {
			return "recover";
		}
		return "copy";
	};

	const authAction = evaluate("auth", authSrc, authDst);
	const mcpAction = evaluate("mcp_auth", mcpSrc, mcpDst);

	const mcpReauthSet = new Set<string>([
		...(options.existingMcpReauth ?? []),
		...(mcpSrc.extraWarnings ?? []),
	]);
	const mcpReauthRequired = [...mcpReauthSet].sort();

	if (authAction === "none" && mcpAction === "none") {
		if (
			options.fromBackend !== options.toBackend ||
			options.commitSteadyIfEmpty
		) {
			await writeAuthStorageState(options.stateFile, {
				version: 1,
				status: "steady",
				active_backend: options.toBackend,
				...(mcpReauthRequired.length
					? { mcp_reauth_required: mcpReauthRequired }
					: {}),
			});
		}
		return { migrated: false, mcpReauthRequired };
	}

	// Step 2: Persist write-ahead transition marker BEFORE modifying destination.
	const migratingState: Extract<AuthStorageState, { status: "migrating" }> = {
		version: 1,
		status: "migrating",
		active_backend: options.fromBackend,
		target_backend: options.toBackend,
		stores: {
			auth: authAction === "copy" ? "pending" : "verified",
			mcp_auth: mcpAction === "copy" ? "pending" : "verified",
		},
		...(mcpReauthRequired.length
			? { mcp_reauth_required: mcpReauthRequired }
			: {}),
	};
	await writeAuthStorageState(options.stateFile, migratingState);

	// Step 3: Write and read-back-verify both stores.
	if (authAction === "copy") {
		await options.authSlot.writeDest(authSrc.normalized);
		const verified = await options.authSlot.verifyDest(authSrc.normalized);
		if (!verified) {
			throw new Error("auth migration read-back verification failed");
		}
		migratingState.stores.auth = "verified";
		await writeAuthStorageState(options.stateFile, migratingState);
	}
	if (mcpAction === "copy") {
		await options.mcpSlot.writeDest(mcpSrc.normalized);
		const verified = await options.mcpSlot.verifyDest(mcpSrc.normalized);
		if (!verified) {
			throw new Error("mcp-auth migration read-back verification failed");
		}
		migratingState.stores.mcp_auth = "verified";
		await writeAuthStorageState(options.stateFile, migratingState);
	}

	// Step 4: Persist pending cleanup state BEFORE removing source copies so a
	// crash before cleanup finishes resumes deletion instead of stranding stale
	// credentials on the old backend.
	if (authSrc.present || mcpSrc.present) {
		migratingState.cleanup_pending = {
			source_backend: options.cleanupSourceKind ?? options.fromBackend,
			auth: authSrc.present,
			mcp_auth: mcpSrc.present,
		};
		await writeAuthStorageState(options.stateFile, migratingState);
	}

	// Step 5: Remove migrated source files/entries.
	if (authSrc.present) {
		await options.authSlot.cleanupSource();
	}
	if (mcpSrc.present) {
		await options.mcpSlot.cleanupSource();
	}

	// Step 6: Commit steady state ONLY after verification AND source cleanup finish.
	await writeAuthStorageState(options.stateFile, {
		version: 1,
		status: "steady",
		active_backend: options.toBackend,
		...(mcpReauthRequired.length
			? { mcp_reauth_required: mcpReauthRequired }
			: {}),
	});

	return { migrated: true, mcpReauthRequired };
};
