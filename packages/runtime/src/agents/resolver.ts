import { promises as fs } from "node:fs";
import path from "node:path";
import {
	type AgentsConfig,
	AgentsConfigSchema,
	type AgentsResolveReason,
	type ResolvedAgentFile,
	ResolvedAgentsSchema,
} from "./schema";

const DEFAULT_MARKERS = [".codelia", ".git", ".jj"];
const DEFAULT_INITIAL_MAX_FILES = 16;
const DEFAULT_INITIAL_MAX_BYTES = 256 * 1024;
const DEFAULT_RESOLVE_MAX_FILES = 8;

type ResolvedAgentsConfig = {
	enabled: boolean;
	root: {
		projectRootOverride?: string;
		markers: string[];
		stopAtFsRoot: boolean;
	};
	initial: {
		maxFiles: number;
		maxBytes: number;
	};
	resolver: {
		enabled: boolean;
		maxFilesPerResolve: number;
	};
};

export type InitialAgentsFile = ResolvedAgentFile & { content: string };

export type ResolvedAgentWithReason = ResolvedAgentFile & {
	reason: AgentsResolveReason;
};

export type AgentsResolverSnapshot = {
	enabled: boolean;
	rootDir: string;
	workingDir: string;
	coveredDirs: string[];
	initialFiles: ResolvedAgentFile[];
	loadedFiles: ResolvedAgentFile[];
};

const toTrimmed = (value?: string): string | undefined => {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const parseBoolean = (value?: string): boolean | undefined => {
	const normalized = toTrimmed(value)?.toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "1" || normalized === "true") return true;
	if (normalized === "0" || normalized === "false") return false;
	return undefined;
};

const parsePositiveInt = (value?: string): number | undefined => {
	const normalized = toTrimmed(value);
	if (!normalized) return undefined;
	const parsed = Number.parseInt(normalized, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const parseMarkers = (value?: string): string[] | undefined => {
	const normalized = toTrimmed(value);
	if (!normalized) return undefined;
	const markers = normalized
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return markers.length > 0 ? markers : undefined;
};

const exists = async (targetPath: string): Promise<boolean> => {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
};

const normalizeMtime = (value: number): number =>
	Number.isFinite(value) && value >= 0 ? value : 0;

const normalizeSize = (value: number): number =>
	Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

const resolvePathChain = (rootDir: string, targetDir: string): string[] => {
	const normalizedRoot = path.resolve(rootDir);
	const normalizedTarget = path.resolve(targetDir);
	const relative = path.relative(normalizedRoot, normalizedTarget);
	if (
		relative.startsWith("..") ||
		path.isAbsolute(relative) ||
		relative === ".."
	) {
		return [];
	}
	const parts = relative.split(path.sep).filter((part) => part.length > 0);
	const chain = [normalizedRoot];
	let current = normalizedRoot;
	for (const part of parts) {
		current = path.join(current, part);
		chain.push(current);
	}
	return chain;
};

const readAgentsStat = async (
	directoryPath: string,
): Promise<ResolvedAgentFile | null> => {
	const filePath = path.join(directoryPath, "AGENTS.md");
	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(filePath);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;
	return {
		path: filePath,
		mtimeMs: normalizeMtime(stat.mtimeMs),
		sizeBytes: normalizeSize(stat.size),
	};
};

const resolveTargetDirectory = async (targetPath: string): Promise<string> => {
	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(targetPath);
	} catch {
		return path.dirname(targetPath);
	}
	return stat.isDirectory() ? targetPath : path.dirname(targetPath);
};

const findRootByMarkers = async (
	workingDir: string,
	markers: string[],
	stopAtFsRoot: boolean,
): Promise<string> => {
	let current = path.resolve(workingDir);
	while (true) {
		for (const marker of markers) {
			const markerPath = path.join(current, marker);
			if (await exists(markerPath)) {
				return current;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return path.resolve(workingDir);
		}
		if (!stopAtFsRoot) {
			current = parent;
			continue;
		}
		current = parent;
	}
};

const mergeConfig = (
	config?: AgentsConfig,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentsConfig => {
	const envConfig = AgentsConfigSchema.parse({
		enabled: parseBoolean(env.CODELIA_AGENTS_ENABLED),
		root: {
			projectRootOverride: toTrimmed(env.CODELIA_AGENTS_ROOT),
			markers: parseMarkers(env.CODELIA_AGENTS_MARKERS),
		},
		initial: {
			maxFiles: parsePositiveInt(env.CODELIA_AGENTS_INITIAL_MAX_FILES),
			maxBytes: parsePositiveInt(env.CODELIA_AGENTS_INITIAL_MAX_BYTES),
		},
		resolver: {
			enabled: parseBoolean(env.CODELIA_AGENTS_RESOLVER_ENABLED),
			maxFilesPerResolve: parsePositiveInt(
				env.CODELIA_AGENTS_MAX_FILES_PER_RESOLVE,
			),
		},
	});
	const merged = AgentsConfigSchema.parse({
		...(config ?? {}),
		...envConfig,
		root: {
			...(config?.root ?? {}),
			...(envConfig.root ?? {}),
		},
		initial: {
			...(config?.initial ?? {}),
			...(envConfig.initial ?? {}),
		},
		resolver: {
			...(config?.resolver ?? {}),
			...(envConfig.resolver ?? {}),
		},
	});

	return {
		enabled: merged.enabled ?? true,
		root: {
			projectRootOverride: merged.root?.projectRootOverride
				? path.resolve(merged.root.projectRootOverride)
				: undefined,
			markers: merged.root?.markers?.length
				? merged.root.markers
				: [...DEFAULT_MARKERS],
			stopAtFsRoot: merged.root?.stopAtFsRoot ?? true,
		},
		initial: {
			maxFiles: merged.initial?.maxFiles ?? DEFAULT_INITIAL_MAX_FILES,
			maxBytes: merged.initial?.maxBytes ?? DEFAULT_INITIAL_MAX_BYTES,
		},
		resolver: {
			enabled: merged.resolver?.enabled ?? true,
			maxFilesPerResolve:
				merged.resolver?.maxFilesPerResolve ?? DEFAULT_RESOLVE_MAX_FILES,
		},
	};
};

export class AgentsResolver {
	private readonly config: ResolvedAgentsConfig;
	private readonly workingDir: string;
	private readonly rootDir: string;
	private readonly initialFiles: InitialAgentsFile[];
	private readonly coveredDirs = new Set<string>();
	private readonly loadedFiles = new Map<string, ResolvedAgentFile>();

	private constructor(options: {
		workingDir: string;
		rootDir: string;
		config: ResolvedAgentsConfig;
		initialFiles: InitialAgentsFile[];
	}) {
		this.workingDir = options.workingDir;
		this.rootDir = options.rootDir;
		this.config = options.config;
		this.initialFiles = options.initialFiles;
	}

	static async create(
		workingDir: string,
		config?: AgentsConfig,
		env: NodeJS.ProcessEnv = process.env,
	): Promise<AgentsResolver> {
		const normalizedWorkingDir = path.resolve(workingDir);
		const merged = mergeConfig(config, env);
		const rootDir = merged.root.projectRootOverride
			? path.resolve(merged.root.projectRootOverride)
			: await findRootByMarkers(
					normalizedWorkingDir,
					merged.root.markers,
					merged.root.stopAtFsRoot,
				);
		const resolver = new AgentsResolver({
			workingDir: normalizedWorkingDir,
			rootDir,
			config: merged,
			initialFiles: [],
		});
		await resolver.loadInitialChain();
		return resolver;
	}

	private registerLoaded(file: ResolvedAgentFile): void {
		const normalizedPath = path.resolve(file.path);
		this.loadedFiles.set(normalizedPath, {
			path: normalizedPath,
			mtimeMs: normalizeMtime(file.mtimeMs),
			sizeBytes: normalizeSize(file.sizeBytes),
		});
		this.coveredDirs.add(path.dirname(normalizedPath));
	}

	private getLoadedFile(filePath: string): ResolvedAgentFile | undefined {
		return this.loadedFiles.get(path.resolve(filePath));
	}

	private async loadInitialChain(): Promise<void> {
		if (!this.config.enabled) {
			return;
		}
		const directories = resolvePathChain(this.rootDir, this.workingDir);
		if (!directories.length) {
			return;
		}
		let bytes = 0;
		for (const directoryPath of directories) {
			if (this.initialFiles.length >= this.config.initial.maxFiles) {
				break;
			}
			const stat = await readAgentsStat(directoryPath);
			if (!stat) {
				continue;
			}
			let content: string;
			try {
				content = await fs.readFile(stat.path, "utf8");
			} catch {
				continue;
			}
			const contentBytes = Buffer.byteLength(content, "utf8");
			if (bytes + contentBytes > this.config.initial.maxBytes) {
				break;
			}
			this.initialFiles.push({ ...stat, content });
			bytes += contentBytes;
			this.registerLoaded(stat);
		}
	}

	buildInitialContext(): string | null {
		if (!this.initialFiles.length) {
			return null;
		}
		const body = this.initialFiles
			.map((entry) => {
				const content = entry.content.replace(/\s+$/u, "");
				return `Instructions from: ${entry.path}\n${content}`;
			})
			.join("\n\n");
		return `<agents_context scope="initial">\n${body}\n</agents_context>`;
	}

	async resolveForPath(targetPath: string): Promise<ResolvedAgentWithReason[]> {
		if (!this.config.enabled || !this.config.resolver.enabled) {
			return [];
		}
		const normalizedTargetPath = path.resolve(targetPath);
		const targetDir = await resolveTargetDirectory(normalizedTargetPath);
		const directories = resolvePathChain(this.rootDir, targetDir);
		if (!directories.length) {
			return [];
		}

		const pending: ResolvedAgentWithReason[] = [];
		for (const directoryPath of directories) {
			const stat = await readAgentsStat(directoryPath);
			if (!stat) {
				continue;
			}
			this.coveredDirs.add(directoryPath);
			const previousFile = this.getLoadedFile(stat.path);
			let reason: AgentsResolveReason | null = null;
			if (!previousFile) {
				reason = "new";
			} else if (previousFile.mtimeMs !== stat.mtimeMs) {
				reason = "updated";
			}
			if (!reason) {
				continue;
			}
			pending.push({ ...stat, reason });
			if (pending.length >= this.config.resolver.maxFilesPerResolve) {
				break;
			}
		}

		const parsed = ResolvedAgentsSchema.parse({
			files: pending.map(({ reason: _reason, ...file }) => file),
		});
		const resolved = parsed.files.map((file, index) => ({
			...file,
			reason: pending[index].reason,
		}));
		for (const file of resolved) {
			this.registerLoaded(file);
		}
		return resolved;
	}

	getRootDir(): string {
		return this.rootDir;
	}

	getCoveredDirs(): string[] {
		return [...this.coveredDirs].sort((a, b) => a.localeCompare(b));
	}

	getLoadedVersion(filePath: string): number | undefined {
		return this.getLoadedFile(filePath)?.mtimeMs;
	}

	getSnapshot(): AgentsResolverSnapshot {
		return {
			enabled: this.config.enabled,
			rootDir: this.rootDir,
			workingDir: this.workingDir,
			coveredDirs: this.getCoveredDirs(),
			initialFiles: this.initialFiles
				.map(({ path: filePath, mtimeMs, sizeBytes }) => ({
					path: filePath,
					mtimeMs,
					sizeBytes,
				}))
				.sort((left, right) => left.path.localeCompare(right.path)),
			loadedFiles: [...this.loadedFiles.values()].sort((left, right) =>
				left.path.localeCompare(right.path),
			),
		};
	}
}

export const appendInitialAgentsContext = (
	systemPrompt: string,
	agentsContext: string | null,
): string => {
	if (!agentsContext) {
		return systemPrompt;
	}
	return `${systemPrompt}\n\n${agentsContext}`;
};
