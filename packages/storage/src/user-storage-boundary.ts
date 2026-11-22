import { promises as fs, lstatSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultHomeConfigDir } from "./paths";

export const isWithinPath = (root: string, target: string): boolean => {
	const relative = path.relative(root, target);
	return (
		!path.isAbsolute(relative) &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`)
	);
};

export const canonicalPathOrResolvedSync = (target: string): string => {
	const resolved = path.resolve(target);
	try {
		return realpathSync(resolved);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return resolved;
		const parent = path.dirname(resolved);
		if (parent === resolved) return resolved;
		return path.join(
			canonicalPathOrResolvedSync(parent),
			path.basename(resolved),
		);
	}
};

export const isSameConfigFilePath = (
	leftPath: string,
	rightPath: string,
): boolean => {
	const left = canonicalPathOrResolvedSync(leftPath);
	const right = canonicalPathOrResolvedSync(rightPath);
	const samePath =
		process.platform === "win32"
			? left.toLowerCase() === right.toLowerCase()
			: left === right;
	if (samePath) return true;
	const leftStat = statSync(left, { bigint: true, throwIfNoEntry: false });
	const rightStat = statSync(right, { bigint: true, throwIfNoEntry: false });
	return (
		!!leftStat &&
		!!rightStat &&
		leftStat.ino !== 0n &&
		leftStat.dev === rightStat.dev &&
		leftStat.ino === rightStat.ino
	);
};

export const isCanonicalHomeWorkspaceSync = (workspace: string): boolean => {
	try {
		const home = path.resolve(os.homedir());
		return realpathSync(workspace) === realpathSync(home);
	} catch {
		return false;
	}
};

const isOwnedAncestor = (
	info: { isDirectory(): boolean; uid: number; mode: number },
	uid: number,
): boolean =>
	info.isDirectory() &&
	(info.uid === 0 || info.uid === uid) &&
	((info.mode & 0o022) === 0 || (info.mode & 0o1000) !== 0);

const isOwnedPrivateDirectory = (
	info: { isDirectory(): boolean; uid: bigint; mode: bigint },
	uid: number,
): boolean =>
	info.isDirectory() && info.uid === BigInt(uid) && (info.mode & 0o022n) === 0n;

export const verifyOwnedAncestors = async (
	directory: string,
	uid: number,
	errorMessage = "unsafe_projects_policy_ancestor",
): Promise<void> => {
	let child = directory;
	while (child !== path.dirname(child)) {
		child = path.dirname(child);
		const info = await fs.stat(child);
		if (!isOwnedAncestor(info, uid)) throw new Error(errorMessage);
	}
};

export const verifyOwnedAncestorsSync = (
	directory: string,
	uid: number,
	errorMessage = "unsafe_projects_policy_ancestor",
): void => {
	let child = directory;
	while (child !== path.dirname(child)) {
		child = path.dirname(child);
		const info = statSync(child);
		if (!isOwnedAncestor(info, uid)) throw new Error(errorMessage);
	}
};

type VerifyStorageLocationParams = {
	workspace: string;
	configured: string;
	resolved: string;
	relativePath?: string;
	reservedOverride?: string;
	errorMessage?: string;
	redirectErrorMessage?: string;
};

const evaluateHomeReservedStorage = ({
	workspace,
	configured,
	resolved,
	relativePath,
	reservedOverride,
	home,
	canonicalHome,
	errorMessage,
	redirectErrorMessage,
}: {
	workspace: string;
	configured: string;
	resolved: string;
	relativePath: string;
	reservedOverride?: string;
	home: string;
	canonicalHome: string;
	errorMessage: string;
	redirectErrorMessage: string;
}): void => {
	const apparentHome = isWithinPath(home, configured) ? home : canonicalHome;
	const base = resolveDefaultHomeConfigDir(apparentHome);
	const expectedReserved = path.resolve(
		reservedOverride ?? (relativePath ? path.join(base, relativePath) : base),
	);
	if (
		workspace !== canonicalHome ||
		configured !== expectedReserved ||
		!isWithinPath(apparentHome, configured)
	)
		throw new Error(errorMessage);
	const expectedResolved = path.join(
		canonicalHome,
		path.relative(apparentHome, configured),
	);
	if (resolved !== expectedResolved) throw new Error(redirectErrorMessage);
};

export const verifyUserStorageLocation = async ({
	workspace,
	configured,
	resolved,
	relativePath = "",
	reservedOverride,
	errorMessage = "unsafe_projects_policy_path",
	redirectErrorMessage = errorMessage,
}: VerifyStorageLocationParams): Promise<{ insideWorkspace: boolean }> => {
	const resolvedConfigured = path.resolve(configured);
	if (
		!isWithinPath(workspace, resolvedConfigured) &&
		!isWithinPath(workspace, resolved)
	)
		return { insideWorkspace: false };
	const home = path.resolve(os.homedir());
	let canonicalHome: string;
	try {
		canonicalHome = await fs.realpath(home);
	} catch {
		throw new Error(errorMessage);
	}
	evaluateHomeReservedStorage({
		workspace,
		configured: resolvedConfigured,
		resolved,
		relativePath,
		reservedOverride,
		home,
		canonicalHome,
		errorMessage,
		redirectErrorMessage,
	});
	return { insideWorkspace: true };
};

export const verifyUserStorageLocationSync = ({
	workspace,
	configured,
	resolved,
	relativePath = "",
	reservedOverride,
	errorMessage = "unsafe_projects_policy_path",
	redirectErrorMessage = errorMessage,
}: VerifyStorageLocationParams): { insideWorkspace: boolean } => {
	const resolvedConfigured = path.resolve(configured);
	if (
		!isWithinPath(workspace, resolvedConfigured) &&
		!isWithinPath(workspace, resolved)
	)
		return { insideWorkspace: false };
	const home = path.resolve(os.homedir());
	let canonicalHome: string;
	try {
		canonicalHome = realpathSync(home);
	} catch {
		throw new Error(errorMessage);
	}
	evaluateHomeReservedStorage({
		workspace,
		configured: resolvedConfigured,
		resolved,
		relativePath,
		reservedOverride,
		home,
		canonicalHome,
		errorMessage,
		redirectErrorMessage,
	});
	return { insideWorkspace: true };
};

/**
 * Check whether `configPath` can be trusted as a user-global config file for
 * `workingDir` (for example, when deciding MCP `trustedService`).
 *
 * Files outside `workingDir` are trusted as global. Files inside `workingDir`
 * are trusted only when `workingDir` is the canonical home directory and
 * `configPath` is the owner-verified, non-redirected default reserved
 * `config.json` for the active layout.
 */
export const isTrustedGlobalConfigLocationSync = (
	workingDir: string,
	configPath: string,
): boolean => {
	try {
		const workspace = realpathSync(workingDir);
		const configured = path.resolve(configPath);
		const resolved = canonicalPathOrResolvedSync(configured);
		const { insideWorkspace } = verifyUserStorageLocationSync({
			workspace,
			configured,
			resolved,
			relativePath: "config.json",
			errorMessage: "untrusted_global_config_path",
		});
		if (!insideWorkspace) return true;
		if (typeof process.geteuid !== "function") return false;
		const uid = process.geteuid();
		const dir = path.dirname(resolved);
		if (!isOwnedPrivateDirectory(lstatSync(dir, { bigint: true }), uid))
			return false;
		verifyOwnedAncestorsSync(dir, uid, "untrusted_global_config_path");
		const fileInfo = lstatSync(resolved, {
			bigint: true,
			throwIfNoEntry: false,
		});
		if (
			fileInfo &&
			(!fileInfo.isFile() ||
				fileInfo.nlink !== 1n ||
				fileInfo.uid !== BigInt(uid) ||
				(fileInfo.mode & 0o022n) !== 0n)
		)
			return false;
		return true;
	} catch {
		return false;
	}
};
