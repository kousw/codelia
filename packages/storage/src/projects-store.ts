import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { StoragePaths } from "@codelia/core";
import {
	type ApprovalMode,
	parseApprovalMode,
	parseSandboxMode,
	type SandboxMode,
} from "@codelia/shared-types";
import { ensureStorageDirs, resolveStoragePaths } from "./paths";
import { openSqlite, type SqliteAdapter } from "./sqlite";

export type ProjectSandboxPolicy = {
	remembered_tool_allows?: Array<{ tool: string }>;
	trust_project_allows?: boolean;
	approval_mode?: ApprovalMode;
	sandbox_mode?: SandboxMode;
	protected_paths?: string[];
};

export type ProjectsPolicyFile = {
	version: 1;
	default?: ProjectSandboxPolicy;
	projects?: Record<string, ProjectSandboxPolicy>;
};

type ParsedProjectsPolicy = {
	raw: Record<string, unknown>;
	normalized: ProjectsPolicyFile;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const within = (root: string, target: string): boolean => {
	const relative = path.relative(root, target);
	return (
		!path.isAbsolute(relative) &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`)
	);
};

const missing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";

const lockFileFor = (file: string) =>
	path.join(path.dirname(file), ".projects-policy-lock.sqlite");

const lstatIfPresent = (file: string) =>
	fs.lstat(file).catch((error: unknown) => {
		if (!missing(error)) throw error;
		return undefined;
	});

const verifyLockFile = async (file: string): Promise<void> => {
	const info = await lstatIfPresent(file);
	if (
		info &&
		(!info.isFile() ||
			info.uid !== process.geteuid?.() ||
			info.size === 0 ||
			(info.mode & 0o022) !== 0)
	)
		throw new Error("unsafe_projects_policy_lock");
};

const initializeUpdateLock = async (lockPath: string): Promise<void> => {
	if (await lstatIfPresent(lockPath)) return;
	const temporary = `${lockPath}.${randomUUID()}.tmp`;
	try {
		const file = await fs.open(temporary, "wx", 0o600);
		await file.close();
		const db = await openSqlite(temporary);
		try {
			// Reserve an actual database file. Empty files can use an in-memory
			// transaction before SQLite has written its header.
			db.exec("PRAGMA user_version = 1");
		} finally {
			db.close();
		}
		try {
			await fs.link(temporary, lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		await fs.unlink(temporary).catch(() => undefined);
	}
};

const openUpdateLock = async (lockPath: string): Promise<SqliteAdapter> => {
	await initializeUpdateLock(lockPath);
	await verifyLockFile(lockPath);
	const db = await openSqlite(lockPath);
	const deadline = performance.now() + 1000;
	try {
		db.exec("PRAGMA busy_timeout = 0");
		for (;;) {
			try {
				db.exec("BEGIN IMMEDIATE");
				return db;
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code !== "SQLITE_BUSY" ||
					performance.now() >= deadline
				)
					throw error;
				await delay(20);
			}
		}
	} catch (error) {
		db.close();
		throw error;
	}
};

const verifyAncestors = async (
	directory: string,
	uid: number,
): Promise<void> => {
	let child = directory;
	while (child !== path.dirname(child)) {
		child = path.dirname(child);
		const info = await fs.stat(child);
		if (
			!info.isDirectory() ||
			(info.uid !== 0 && info.uid !== uid) ||
			((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
		)
			throw new Error("unsafe_projects_policy_ancestor");
	}
};

const normalizeProjectPolicy = (
	value: unknown,
	field: string,
): ProjectSandboxPolicy => {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	const { approval_mode, sandbox_mode, protected_paths, trust_project_allows } =
		value;
	if (
		trust_project_allows !== undefined &&
		typeof trust_project_allows !== "boolean"
	)
		throw new Error(`${field}.trust_project_allows must be boolean`);
	const approvalMode = parseApprovalMode(approval_mode);
	const sandboxMode = parseSandboxMode(sandbox_mode);
	const toolAllows = value.remembered_tool_allows;
	if (
		toolAllows !== undefined &&
		(!Array.isArray(toolAllows) ||
			toolAllows.some(
				(rule) =>
					!isRecord(rule) ||
					Object.keys(rule).length !== 1 ||
					typeof rule.tool !== "string" ||
					!/^[a-z][a-z0-9_]*$/.test(rule.tool),
			))
	)
		throw new Error(
			`${field}.remembered_tool_allows must contain tool-only rules`,
		);
	if (approval_mode !== undefined && !approvalMode)
		throw new Error(`${field}.approval_mode is invalid`);
	if (sandbox_mode !== undefined && !sandboxMode)
		throw new Error(`${field}.sandbox_mode is invalid`);
	if (
		protected_paths !== undefined &&
		(!Array.isArray(protected_paths) ||
			protected_paths.some(
				(entry) =>
					typeof entry !== "string" ||
					!path.isAbsolute(entry) ||
					[...entry].some(
						(character) => character < " " || character === "\x7f",
					),
			))
	)
		throw new Error(`${field}.protected_paths must contain absolute paths`);
	return {
		...(Array.isArray(toolAllows)
			? { remembered_tool_allows: toolAllows.map(({ tool }) => ({ tool })) }
			: {}),
		...(typeof trust_project_allows === "boolean"
			? { trust_project_allows }
			: {}),
		...(approvalMode ? { approval_mode: approvalMode } : {}),
		...(sandboxMode ? { sandbox_mode: sandboxMode } : {}),
		...(Array.isArray(protected_paths)
			? { protected_paths: [...new Set<string>(protected_paths)] }
			: {}),
	};
};

const normalizeProjectsPolicyFile = (value: unknown): ProjectsPolicyFile => {
	if (!isRecord(value)) {
		throw new Error("projects policy must be an object");
	}
	if (value.version !== 1) {
		throw new Error("projects policy version must be 1");
	}

	const normalized: ProjectsPolicyFile = { version: 1 };
	if (value.default !== undefined) {
		const entry = normalizeProjectPolicy(
			value.default,
			"projects policy default",
		);
		if (Object.keys(entry).length) normalized.default = entry;
	}
	if (value.projects !== undefined) {
		if (!isRecord(value.projects))
			throw new Error("projects policy projects must be an object");
		const entries = Object.entries(value.projects).flatMap(([key, value]) => {
			const entry = normalizeProjectPolicy(
				value,
				`projects policy projects['${key}']`,
			);
			return Object.keys(entry).length ? [[key, entry] as const] : [];
		});
		if (entries.length) normalized.projects = Object.fromEntries(entries);
	}
	return normalized;
};

const atomicWriteFile = async (
	filePath: string,
	content: string,
): Promise<void> => {
	const dirPath = path.dirname(filePath);
	const fileName = path.basename(filePath);
	const tempPath = path.join(
		dirPath,
		`.${fileName}.${process.pid}.${Date.now()}.tmp`,
	);
	await fs.writeFile(tempPath, content, { mode: 0o600 });
	await fs.rename(tempPath, filePath);
	if (process.platform !== "win32") {
		await fs.chmod(filePath, 0o600);
	}
};

export class ProjectsPolicyStore {
	private readonly paths: StoragePaths;

	constructor(paths?: StoragePaths) {
		this.paths = paths ?? resolveStoragePaths();
	}

	getFilePath(): string {
		return this.paths.projectsFile;
	}

	private async verifyWorkspaceLocation(
		workspace: string,
		configured: string,
		file: string,
		access: "read" | "write" | "create",
		reservedFile = resolveStoragePaths().projectsFile,
	): Promise<void> {
		if (!within(workspace, configured) && !within(workspace, file)) return;
		const home = path.resolve(os.homedir());
		const canonicalHome = await fs.realpath(home);
		const apparentHome = within(home, configured) ? home : canonicalHome;
		// The local runtime reserves its own storage. Allow its configured policy
		// in a home-scoped run, while refusing redirects and checkout-owned policy.
		if (
			access === "read" &&
			workspace === canonicalHome &&
			configured === path.resolve(reservedFile) &&
			within(apparentHome, configured) &&
			file === path.join(canonicalHome, path.relative(apparentHome, configured))
		)
			return;
		throw new Error("unsafe_projects_policy_path");
	}

	private async trustedPath(
		workspace: string,
		access: "read" | "write" | "create",
		configured = path.resolve(this.paths.projectsFile),
		reservedFile = resolveStoragePaths().projectsFile,
	): Promise<string> {
		const uid = process.geteuid?.();
		if (uid === undefined) throw new Error("unsafe_projects_policy_path");
		const destination = path.dirname(configured);
		let ancestor = destination;
		let canonical: string;
		for (;;) {
			try {
				canonical = await fs.realpath(ancestor);
				break;
			} catch (error) {
				if (!missing(error) || ancestor === path.dirname(ancestor)) throw error;
				if (await lstatIfPresent(ancestor))
					throw new Error("unsafe_projects_policy_path");
				ancestor = path.dirname(ancestor);
			}
		}
		const directory = path.join(
			canonical,
			path.relative(ancestor, destination),
		);
		const file = path.join(directory, path.basename(configured));
		await this.verifyWorkspaceLocation(
			workspace,
			configured,
			file,
			access,
			reservedFile,
		);
		const owner = await fs.stat(canonical);
		if (!owner.isDirectory() || owner.uid !== uid || (owner.mode & 0o022) !== 0)
			throw new Error("unsafe_projects_policy_directory");
		await verifyAncestors(canonical, uid);
		if (ancestor !== canonical) await verifyAncestors(ancestor, uid);
		if (access !== "read")
			await fs.access(canonical, constants.W_OK | constants.X_OK);
		if (access === "create" && ancestor !== destination) {
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			if ((await fs.realpath(directory)) !== directory)
				throw new Error("unsafe_projects_policy_directory");
			return this.trustedPath(workspace, "write");
		}
		return file;
	}

	private async readUserFile(
		file: string,
		owner: number | null,
	): Promise<string | undefined> {
		const info = await lstatIfPresent(file);
		if (!info) return undefined;
		if (!info.isFile() || info.nlink !== 1)
			throw new Error("unsafe_projects_policy_file");
		const handle = await fs.open(
			file,
			constants.O_RDONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(constants.O_NONBLOCK ?? 0),
		);
		try {
			const current = await handle.stat();
			if (
				!current.isFile() ||
				current.dev !== info.dev ||
				current.ino !== info.ino ||
				current.nlink !== 1 ||
				(owner !== null &&
					(current.uid !== owner || (current.mode & 0o022) !== 0))
			)
				throw new Error("unsafe_projects_policy_file");
			return await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	}

	/** Read user-authored permission settings through the same private-file boundary as project trust. */
	async readUserConfig(
		workspace: string,
		configured: string,
	): Promise<string | undefined> {
		const uid = process.geteuid?.();
		if (uid === undefined) throw new Error("unsafe_projects_policy_path");
		const file = await this.trustedPath(
			workspace,
			"read",
			path.resolve(configured),
			this.paths.configFile,
		);
		return this.readUserFile(file, uid);
	}

	private async readPolicyFile(
		file: string,
		owner: number | null,
	): Promise<ParsedProjectsPolicy> {
		const text = await this.readUserFile(file, owner);
		const raw: unknown = text === undefined ? { version: 1 } : JSON.parse(text);
		const normalized = normalizeProjectsPolicyFile(raw);
		return { raw: raw as Record<string, unknown>, normalized };
	}

	private readTrusted(file: string): Promise<ParsedProjectsPolicy> {
		const owner = process.geteuid?.();
		if (owner === undefined) throw new Error("unsafe_projects_policy_path");
		return this.readPolicyFile(file, owner);
	}

	private async hasUnverifiableProtectedPaths(
		workspace: string,
	): Promise<boolean> {
		const configured = path.resolve(this.paths.projectsFile);
		const canonicalParent = await fs.realpath(path.dirname(configured));
		const file = path.join(canonicalParent, path.basename(configured));
		await this.verifyWorkspaceLocation(workspace, configured, file, "read");
		// Read only to identify legacy files. Without owner checks no policy
		// values, including old sandbox modes, are used as authority.
		const { normalized: policy } = await this.readPolicyFile(file, null);
		return Boolean(
			policy.default?.protected_paths?.length ||
				Object.entries(policy.projects ?? {}).some(
					([root, entry]) =>
						entry.protected_paths?.length &&
						path.isAbsolute(root) &&
						path.relative(workspace, root) === "",
				),
		);
	}

	async loadUserOwned(
		workspace: string,
		{ strict = false }: { strict?: boolean } = {},
	): Promise<ProjectsPolicyFile | null> {
		let hasUnverifiablePaths: boolean;
		try {
			if (strict && !(await lstatIfPresent(this.paths.projectsFile)))
				return null;
			if (strict && process.geteuid?.() === undefined) {
				hasUnverifiablePaths =
					await this.hasUnverifiableProtectedPaths(workspace);
			} else {
				const file = await this.trustedPath(workspace, "read");
				return (await this.readTrusted(file)).normalized;
			}
		} catch (error) {
			if (strict)
				throw new Error("untrusted_projects_policy", { cause: error });
			return null;
		}
		if (hasUnverifiablePaths)
			throw new Error("protected_paths_owner_verification_unavailable");
		return null;
	}

	async verifyProjectModeWritable(workspace: string): Promise<void> {
		const file = await this.trustedPath(workspace, "write");
		await this.readTrusted(file);
		await verifyLockFile(lockFileFor(file));
	}

	/** Merge into a private user policy while other runtimes are excluded. */
	async writeProjectMode(workspace: string, mode: SandboxMode): Promise<void> {
		return this.updateProject(workspace, { sandbox_mode: mode });
	}

	async writeProjectAllowTrust(
		workspace: string,
		trusted: boolean,
		verify: () => void,
	): Promise<void> {
		return this.updateProject(
			workspace,
			{ trust_project_allows: trusted },
			verify,
		);
	}

	async updateRememberedTool(
		workspace: string,
		tool: string,
		allow: boolean,
		verify?: () => void,
	): Promise<boolean> {
		if (!/^[a-z][a-z0-9_]*$/.test(tool))
			throw new Error("invalid_remembered_tool");
		let changed = false;
		await this.updateProject(
			workspace,
			(current) => {
				const exists =
					current.remembered_tool_allows?.some((rule) => rule.tool === tool) ??
					false;
				if (exists === allow) return undefined;
				changed = true;
				return {
					remembered_tool_allows: [
						...(current.remembered_tool_allows ?? []).filter(
							(rule) => rule.tool !== tool,
						),
						...(allow ? [{ tool }] : []),
					],
				};
			},
			verify,
		);
		return changed;
	}

	private async updateProject(
		workspace: string,
		patch:
			| ProjectSandboxPolicy
			| ((current: ProjectSandboxPolicy) => ProjectSandboxPolicy | undefined),
		verify?: () => void,
	): Promise<void> {
		const file = await this.trustedPath(workspace, "create");
		const lock = await openUpdateLock(lockFileFor(file));
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			const { raw: policy } = await this.readTrusted(file);
			const projects = policy.projects as
				| Record<string, ProjectSandboxPolicy>
				| undefined;
			const changes =
				typeof patch === "function"
					? patch(projects?.[workspace] ?? {})
					: patch;
			if (!changes) {
				verify?.();
				return;
			}
			const next = {
				...policy,
				projects: {
					...projects,
					[workspace]: { ...projects?.[workspace], ...changes },
				},
			};
			await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			await fs.chmod(temporary, 0o600);
			if ((await this.trustedPath(workspace, "write")) !== file)
				throw new Error("unsafe_projects_policy_path");
			verify?.();
			await fs.rename(temporary, file);
		} finally {
			lock.close();
			await fs.unlink(temporary).catch(() => undefined);
		}
	}

	async load(canonicalPath?: string): Promise<ProjectsPolicyFile | null> {
		try {
			const handle = await fs.open(
				canonicalPath ?? this.paths.projectsFile,
				canonicalPath
					? constants.O_RDONLY |
							(constants.O_NOFOLLOW ?? 0) |
							(constants.O_NONBLOCK ?? 0)
					: "r",
			);
			let parsed: unknown;
			try {
				if (canonicalPath) {
					const info = await handle.stat();
					const uid = process.geteuid?.();
					if (
						!info.isFile() ||
						info.nlink !== 1 ||
						(uid !== undefined &&
							(info.uid !== uid || (info.mode & 0o022) !== 0))
					)
						return null;
				}
				parsed = JSON.parse(await handle.readFile("utf8"));
			} finally {
				await handle.close();
			}
			return normalizeProjectsPolicyFile(parsed);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return null;
			}
			throw error;
		}
	}

	async save(data: ProjectsPolicyFile): Promise<void> {
		if (data.version !== 1) {
			throw new Error("projects policy version must be 1");
		}
		await ensureStorageDirs(this.paths);
		const content = `${JSON.stringify(data, null, 2)}\n`;
		await atomicWriteFile(this.paths.projectsFile, content);
	}
}
