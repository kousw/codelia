import crypto from "node:crypto";
import {
	type BigIntStats,
	constants,
	promises as fs,
	lstatSync,
	realpathSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import type { ApprovalMode, SandboxMode } from "@codelia/shared-types";
import { gitMetadataPaths } from "../permissions/git-metadata";
import { isHomeWriteReserved } from "../permissions/home-dot-paths";
import {
	hasReadOnlyAliases,
	isProtectedAlias,
} from "../permissions/protected-aliases";
import { resourceContainsPath } from "../permissions/resource-paths";
import {
	canonicalPolicyPaths,
	resolvePolicyPath,
	workspacePathProtection,
} from "../permissions/shell-backend";
import {
	isWorkspaceConfigName,
	workspaceConfigProtection,
} from "../permissions/workspace-config-paths";
import { isWithin } from "../utils/paths";
import type { DirectoryMutationBroker } from "./file-mutations";

export class SecurityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecurityError";
	}
}

type FileOperand = Readonly<{
	operand: string;
	access: "read" | "write";
	target: string;
	directoryEntry?: true;
}>;

export type MissingFileSelection = FileOperand &
	Readonly<{
		identity: null;
		parent: string;
		parentIdentity: string;
		tail: string;
	}>;

export type FileSelection =
	| (FileOperand & Readonly<{ identity: string }>)
	| MissingFileSelection;

const identity = (info: BigIntStats): string =>
	`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

const directoryIdentity = (stat: BigIntStats): string =>
	`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

const selectMissingFile = (entry: FileOperand): MissingFileSelection => {
	let parent = path.dirname(entry.target);
	for (;;) {
		try {
			const stat = lstatSync(parent, { bigint: true });
			if (!stat.isDirectory() || realpathSync(parent) !== parent)
				throw new SecurityError("Expected a canonical parent directory");
			return Object.freeze({
				...entry,
				identity: null,
				parent,
				parentIdentity: directoryIdentity(stat),
				tail: path.relative(parent, entry.target),
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const ancestor = path.dirname(parent);
			if (ancestor === parent) throw error;
			parent = ancestor;
		}
	}
};

export const missingDestinationCurrent = (
	selection: MissingFileSelection,
): boolean => {
	try {
		const segments = selection.tail.split(path.sep);
		if (
			segments.some(
				(segment) => !segment || segment === "." || segment === "..",
			) ||
			path.join(selection.parent, selection.tail) !== selection.target ||
			!directoryBindingCurrent(selection)
		)
			return false;
		let current = selection.parent;
		// Existing intermediate directories must be ordinary children of the
		// approved ancestor. An earlier operation in the same patch may create them.
		for (const [index, segment] of segments.entries()) {
			current = path.join(current, segment);
			const stat = lstatSync(current);
			if (index === segments.length - 1 || !stat.isDirectory()) return false;
		}
		return false;
	} catch (error) {
		// Missing components below the approved ancestor are expected.
		return (
			(error as NodeJS.ErrnoException).code === "ENOENT" &&
			directoryBindingCurrent(selection)
		);
	}
};

const directoryBindingCurrent = (selection: MissingFileSelection): boolean => {
	try {
		const stat = lstatSync(selection.parent, { bigint: true });
		return (
			stat.isDirectory() &&
			directoryIdentity(stat) === selection.parentIdentity &&
			realpathSync(selection.parent) === selection.parent
		);
	} catch {
		return false;
	}
};

type SandboxContextInit = {
	sandboxMode?: SandboxMode;
	rootDir: string;
	workingDir: string;
	sessionId: string;
	approvalMode: ApprovalMode;
	protectedPaths?: readonly string[];
	protectedAliasPaths?: readonly string[];
	readOnlyPaths?: readonly string[];
	homeDotDirectory?: string;
	readOnlyAliasPaths?: readonly string[];
	mutations?: DirectoryMutationBroker;
	selections?: ReadonlyMap<string, FileSelection>;
};

export class SandboxContext {
	readonly sandboxMode?: SandboxMode;
	readonly rootDir: string;
	readonly workingDir: string;
	readonly sessionId: string;
	readonly approvalMode: ApprovalMode;
	private readonly protectedPaths?: readonly string[];
	private readonly protectedAliasPaths?: readonly string[];
	private readonly homeDotDirectory?: string;
	private readonly readOnlyPaths: readonly string[];
	private readonly readOnlyAliasPaths: readonly string[];
	private readonly mutations?: DirectoryMutationBroker;
	private readonly selections?: ReadonlyMap<string, FileSelection>;

	private constructor(init: SandboxContextInit) {
		this.rootDir = init.rootDir;
		this.sandboxMode = init.sandboxMode;
		this.workingDir = init.workingDir;
		this.sessionId = init.sessionId;
		this.approvalMode = init.approvalMode;
		this.protectedPaths = init.protectedPaths;
		this.protectedAliasPaths = init.protectedAliasPaths;
		this.homeDotDirectory = init.homeDotDirectory;
		this.readOnlyPaths = init.readOnlyPaths ?? [];
		this.readOnlyAliasPaths = init.readOnlyAliasPaths ?? this.readOnlyPaths;
		this.selections = init.selections;
		this.mutations = init.mutations;
	}

	static async create(
		rootDir?: string,
		options: {
			approvalMode?: ApprovalMode;
			sandboxMode?: SandboxMode;
			protectResources?: boolean;
			extraProtectedPaths?: readonly string[];
			extraReadOnlyPaths?: readonly string[];
			mutations?:
				| DirectoryMutationBroker
				| ((root: string) => Promise<DirectoryMutationBroker | undefined>);
		} = {},
	): Promise<SandboxContext> {
		const sessionId = crypto.randomUUID().slice(0, 8);
		const root = rootDir ? path.resolve(rootDir) : process.cwd();
		if (options.sandboxMode !== "readonly")
			await fs.mkdir(root, { recursive: true });
		const directory = options.protectResources ? await fs.realpath(root) : root;
		return new SandboxContext({
			rootDir: directory,
			workingDir: directory,
			...(options.protectResources
				? workspacePathProtection(
						directory,
						options.extraProtectedPaths,
						[],
						options.sandboxMode,
						false,
						options.extraReadOnlyPaths,
						{ recheckHomeLinksOnWrite: true },
					)
				: {}),
			sessionId,
			mutations:
				typeof options.mutations === "function"
					? await options.mutations(directory)
					: options.mutations,
			approvalMode: options.approvalMode ?? "minimal",
			sandboxMode: options.sandboxMode,
		});
	}

	resolvePath(targetPath: string, access: "read" | "write" = "write"): string {
		if (access === "write" && this.sandboxMode === "readonly")
			throw new SecurityError("Sandbox mode is readonly");
		const resolved = path.isAbsolute(targetPath)
			? path.resolve(targetPath)
			: path.resolve(this.workingDir, targetPath);
		if (this.protectedPaths) return this.resolveProtectedPath(resolved, access);
		if (this.approvalMode === "full-access") {
			return resolved;
		}
		if (isWithin(this.rootDir, resolved)) {
			return resolved;
		}
		throw new SecurityError(
			`Path escapes sandbox: ${targetPath} -> ${resolved}`,
		);
	}
	get hasResourceProtection(): boolean {
		return this.protectedPaths !== undefined;
	}

	selectFile(
		operand: string,
		access: FileSelection["access"],
		directoryEntry = false,
	): FileSelection {
		const target = this.resolvePath(operand, access);
		if (directoryEntry) {
			const lexical = path.resolve(this.workingDir, operand);
			const name = path.join(
				resolvePolicyPath(path.dirname(lexical)),
				path.basename(lexical),
			);
			if (
				target !== name ||
				lstatSync(name, { throwIfNoEntry: false })?.isSymbolicLink()
			)
				throw new SecurityError(
					"Patch deletion and move require a regular directory entry without a symbolic link",
				);
		}
		const entry = {
			operand,
			access,
			target,
			...(directoryEntry ? { directoryEntry: true as const } : {}),
		};
		try {
			const info = lstatSync(target, { bigint: true });
			if (!info.isFile())
				throw new SecurityError("Expected a regular file for this operation");
			return Object.freeze({
				...entry,
				identity: identity(info),
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return selectMissingFile(entry);
		}
	}

	bindFiles(files: readonly FileSelection[]): SandboxContext {
		return new SandboxContext({
			rootDir: this.rootDir,
			workingDir: this.workingDir,
			sessionId: this.sessionId,
			approvalMode: this.approvalMode,
			sandboxMode: this.sandboxMode,
			protectedPaths: this.protectedPaths,
			protectedAliasPaths: this.protectedAliasPaths,
			homeDotDirectory: this.homeDotDirectory,
			readOnlyPaths: this.readOnlyPaths,
			readOnlyAliasPaths: this.readOnlyAliasPaths,
			mutations: this.mutations,
			selections: new Map(files.map((file) => [file.operand, file])),
		});
	}

	fileBindingsCurrent(): boolean {
		try {
			for (const entry of this.selections?.values() ?? [])
				this.checkSelected(entry.operand, entry.access);
			return true;
		} catch {
			return false;
		}
	}

	async withSelectedFile<T>(
		operand: string,
		access: FileSelection["access"],
		mode: "read" | "update",
		callback: (handle: FileHandle) => Promise<T>,
	): Promise<T> {
		if (mode === "update" && access !== "write")
			throw new SecurityError("A write binding is required for file updates");
		const selected = this.checkSelected(operand, access);
		if (selected.identity === null) {
			if (mode === "update")
				throw new SecurityError("sandbox_write_creation_unavailable");
			const error = new Error("File not found") as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		const flags =
			(mode === "read" ? constants.O_RDONLY : constants.O_RDWR) |
			(constants.O_NOFOLLOW ?? 0) |
			(constants.O_NONBLOCK ?? 0);
		const handle = await fs.open(selected.target, flags);
		try {
			const opened = await handle.stat({ bigint: true });
			if (
				!opened.isFile() ||
				identity(opened) !== selected.identity ||
				isProtectedAlias(
					opened,
					canonicalPolicyPaths(this.protectedAliasPaths ?? []),
				) ||
				(access === "write" && this.isReadOnlyAlias(opened, selected.target))
			)
				throw new SecurityError("Opened file does not match approved target");
			return await callback(handle);
		} finally {
			await handle.close();
		}
	}

	readSelectedFile(
		operand: string,
		access: FileSelection["access"] = "read",
	): Promise<Buffer> {
		return this.withSelectedFile(operand, access, "read", async (handle) => {
			const before = await handle.stat({ bigint: true });
			const bytes = await handle.readFile();
			if (identity(await handle.stat({ bigint: true })) !== identity(before))
				throw new SecurityError("File changed during read");
			return bytes;
		});
	}

	supportsDirectoryMutation(): boolean {
		return this.mutations?.supports() === true;
	}

	private checkSelected(
		operand: string,
		access: FileSelection["access"],
		directoryEntry = false,
	): FileSelection {
		const binding = this.selections?.get(operand);
		const current = this.selectFile(
			operand,
			access,
			directoryEntry || binding?.directoryEntry,
		);
		const selected = binding ?? current;
		if (
			selected.access !== access ||
			current.target !== selected.target ||
			current.identity !== selected.identity ||
			(selected.identity === null && !missingDestinationCurrent(selected))
		)
			throw new SecurityError("File selection changed after approval");
		return selected;
	}

	async writeSelectedFile(
		operand: string,
		value: string,
		signal?: AbortSignal,
	): Promise<void> {
		const selected = this.checkSelected(operand, "write");
		if (selected.identity === null) {
			if (!this.mutations)
				throw new SecurityError("sandbox_write_creation_unavailable");
			return this.mutations.run(
				{ kind: "create", destination: selected, content: value },
				signal,
			);
		}
		return this.withSelectedFile(operand, "write", "update", async (handle) => {
			signal?.throwIfAborted();
			const bytes = Buffer.from(value);
			await handle.writeFile(bytes);
			await handle.truncate(bytes.length);
		});
	}

	createSelectedFile(
		operand: string,
		value: Uint8Array,
		mode: number,
		signal?: AbortSignal,
	): Promise<void> {
		const selected = this.checkSelected(operand, "write");
		if (selected.identity !== null)
			throw new SecurityError("Destination exists");
		if (!this.mutations)
			throw new SecurityError("sandbox_write_creation_unavailable");
		return this.mutations.run(
			{ kind: "create", destination: selected, content: value, mode },
			signal,
		);
	}

	deleteSelectedFile(operand: string, signal?: AbortSignal): Promise<void> {
		if (!this.mutations)
			throw new SecurityError("sandbox_directory_mutation_unavailable");
		return this.mutations.run(
			{ kind: "delete", source: this.checkSelected(operand, "write", true) },
			signal,
		);
	}

	moveSelectedFile(
		operand: string,
		target: string,
		content: string,
		mode?: number,
		signal?: AbortSignal,
	): Promise<void> {
		if (!this.mutations)
			throw new SecurityError("sandbox_directory_mutation_unavailable");
		const destination = this.checkSelected(target, "write", true);
		if (destination.identity !== null)
			throw new SecurityError("Move destination exists");
		return this.mutations.run(
			{
				kind: "move",
				source: this.checkSelected(operand, "write", true),
				destination,
				content,
				mode,
			},
			signal,
		);
	}

	private writeProtection(target: string, alias = false): readonly string[] {
		const { readOnlyPaths } = gitMetadataPaths(
			this.rootDir,
			path.dirname(target),
		);
		const projectConfig = workspaceConfigProtection(this.rootDir);
		return [
			...readOnlyPaths,
			...(alias
				? [...this.readOnlyAliasPaths, ...projectConfig.readOnlyAliasPaths]
				: [...this.readOnlyPaths, ...projectConfig.readOnlyPaths]),
		];
	}

	private isReadOnlyAlias(stat: BigIntStats, target: string): boolean {
		return (
			this.hasResourceProtection &&
			stat.nlink > 1n &&
			hasReadOnlyAliases(this.writeProtection(target, true), stat)
		);
	}

	private resolveProtectedPath(
		resolved: string,
		access: "read" | "write",
	): string {
		const protectedPaths = canonicalPolicyPaths(this.protectedPaths ?? []);
		const rejectProtected = (value: string) => {
			if (protectedPaths.some((entry) => resourceContainsPath(entry, value))) {
				throw new SecurityError("Path is protected by the resource policy");
			}
		};
		const rejectWrite = (value: string) => {
			if (access !== "write") return;
			if (!isWithin(this.rootDir, value))
				throw new SecurityError("Write path escapes the workspace");
			if (
				(this.homeDotDirectory &&
					isHomeWriteReserved(this.homeDotDirectory, value)) ||
				isWorkspaceConfigName(this.rootDir, value) ||
				this.writeProtection(value).some((entry) =>
					resourceContainsPath(entry, value),
				)
			)
				throw new SecurityError("Path is read-only under the resource policy");
		};
		rejectProtected(resolved);
		rejectWrite(resolved);
		let probe = resolved;
		for (;;) {
			try {
				const actual = realpathSync(probe);
				const target = path.resolve(actual, path.relative(probe, resolved));
				rejectProtected(target);
				if (target !== resolved) rejectWrite(target);
				if (probe === resolved) {
					const stat = lstatSync(target);
					if (!stat.isFile() && !stat.isDirectory())
						throw new SecurityError("Unsupported file type");
					if (stat.isFile() && stat.nlink > 1) {
						const inode = lstatSync(target, { bigint: true });
						if (isProtectedAlias(inode, protectedPaths))
							throw new SecurityError("Path aliases a protected file");
						if (access === "write" && this.isReadOnlyAlias(inode, target))
							throw new SecurityError("Path aliases a read-only file");
					}
				}
				return target;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const ancestor = path.dirname(probe);
				if (ancestor === probe) throw error;
				// A dangling symlink is an existing directory entry and must not be
				// treated as an ordinary missing filename.
				try {
					if (lstatSync(probe).isSymbolicLink())
						throw new SecurityError("Path contains a dangling symlink");
				} catch (entryError) {
					if ((entryError as NodeJS.ErrnoException).code !== "ENOENT")
						throw entryError;
				}
				probe = ancestor;
			}
		}
	}
}

export const createSandboxKey = (
	ctx: SandboxContext,
): DependencyKey<SandboxContext> => ({
	id: "sandbox-context",
	create: () => ctx,
});

export const getSandboxContext = async (
	ctx: ToolContext,
	key: DependencyKey<SandboxContext>,
): Promise<SandboxContext> => ctx.resolve(key);
