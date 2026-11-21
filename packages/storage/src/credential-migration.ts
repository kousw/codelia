import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic-file";

export type CredentialBackendKind = "file" | "keyring";
export type StoreMigrationStatus = "pending" | "verified";

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

export const readAuthStorageState = async (
	stateFile: string,
): Promise<AuthStorageState | null> => {
	let text: string;
	try {
		text = await fs.readFile(stateFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
	const parsed = JSON.parse(text) as unknown;
	if (!isRecord(parsed) || parsed.version !== 1) {
		throw new Error("storage-state.json has unsupported version");
	}
	const active = parsed.active_backend;
	if (active !== "file" && active !== "keyring") {
		throw new Error("storage-state.json has invalid active_backend");
	}
	const mcpReauth =
		Array.isArray(parsed.mcp_reauth_required) &&
		parsed.mcp_reauth_required.every((item) => typeof item === "string")
			? (parsed.mcp_reauth_required as string[])
			: undefined;

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
		return {
			version: 1,
			status: "migrating",
			active_backend: active,
			target_backend: target,
			stores: { auth: authStatus, mcp_auth: mcpStatus },
			...(mcpReauth?.length ? { mcp_reauth_required: mcpReauth } : {}),
		};
	}
	throw new Error("storage-state.json has invalid status");
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
	authSlot: StoreMigrationSlot<TAuth>;
	mcpSlot: StoreMigrationSlot<TMcp>;
	existingMcpReauth?: string[];
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
		return { migrated: false, mcpReauthRequired };
	}

	// Step 2: Persist write-ahead transition marker BEFORE modifying destination.
	const migratingState: AuthStorageState = {
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

	// Step 4: Commit steady state ONLY after both stores are verified.
	await writeAuthStorageState(options.stateFile, {
		version: 1,
		status: "steady",
		active_backend: options.toBackend,
		...(mcpReauthRequired.length
			? { mcp_reauth_required: mcpReauthRequired }
			: {}),
	});

	// Step 5: Remove migrated source files/entries.
	if (authSrc.present) {
		await options.authSlot.cleanupSource();
	}
	if (mcpSrc.present) {
		await options.mcpSlot.cleanupSource();
	}

	return { migrated: true, mcpReauthRequired };
};
