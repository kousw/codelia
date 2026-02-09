import crypto from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillsListResult } from "@codelia/protocol";
import type { ResolvedSkillsConfig } from "../config";

const DEFAULT_MARKERS = [".codelia", ".git", ".jj"];
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_FILES = 200;
const MAX_SKILL_FILE_BYTES = 512 * 1024;

type SkillMetadata = SkillsListResult["skills"][number];
type SkillLoadError = SkillsListResult["errors"][number];

export type SkillSearchReason =
	| "exact_name"
	| "exact_path"
	| "prefix"
	| "token_overlap";

export type SkillSearchResult = {
	skill: SkillMetadata;
	score: number;
	reason: SkillSearchReason;
};

export type SkillCatalog = {
	skills: SkillMetadata[];
	errors: SkillLoadError[];
	truncated: boolean;
};

export type SkillLoadResult =
	| {
			ok: true;
			skill: SkillMetadata;
			already_loaded: boolean;
			content: string;
			files: string[];
			files_truncated: boolean;
	  }
	| {
			ok: false;
			message: string;
			ambiguous_paths?: string[];
	  };

export type SkillsResolverSnapshot = {
	enabled: boolean;
	root_dir: string;
	working_dir: string;
	catalog: SkillCatalog;
	loaded_versions: Array<{ path: string; mtime_ms: number }>;
};

const toTrimmed = (value?: string): string | undefined => {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
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

const findRootByMarkers = async (
	workingDir: string,
	markers: string[],
): Promise<string> => {
	let current = path.resolve(workingDir);
	while (true) {
		for (const marker of markers) {
			if (await exists(path.join(current, marker))) {
				return current;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return path.resolve(workingDir);
		}
		current = parent;
	}
};

const tryResolvePath = async (
	targetPath: string,
): Promise<{ resolved: string; canonical: string }> => {
	const resolved = path.resolve(targetPath);
	try {
		return { resolved, canonical: await fs.realpath(resolved) };
	} catch {
		return { resolved, canonical: resolved };
	}
};

const isWithin = (basePath: string, candidatePath: string): boolean => {
	const relative = path.relative(basePath, candidatePath);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
};

const hashPath = (value: string): string =>
	crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);

const parseFrontmatter = (content: string): Record<string, string> | null => {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return null;
	}
	const end = normalized.indexOf("\n---\n", 4);
	const endAtEof =
		end < 0 && normalized.endsWith("\n---")
			? normalized.length - "\n---".length
			: -1;
	const boundary = end >= 0 ? end : endAtEof;
	if (boundary < 0) {
		return null;
	}
	const frontmatter = normalized.slice(4, boundary);
	const result: Record<string, string> = {};
	for (const rawLine of frontmatter.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const sep = line.indexOf(":");
		if (sep <= 0) continue;
		const key = line.slice(0, sep).trim();
		let value = line.slice(sep + 1).trim();
		if (!key) continue;
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
};

const tokenize = (value: string): string[] =>
	value
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);

const scopeRank = (scope: "repo" | "user"): number =>
	scope === "repo" ? 0 : 1;

const xmlEscape = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

type SkillsResolverOptions = {
	workingDir: string;
	config: ResolvedSkillsConfig;
	env?: NodeJS.ProcessEnv;
};

export class SkillsResolver {
	private readonly workingDir: string;
	private readonly rootDir: string;
	private readonly config: ResolvedSkillsConfig;
	private readonly userSkillsDir: string;
	private catalog: SkillCatalog = { skills: [], errors: [], truncated: false };
	private readonly loadedVersions = new Map<string, number>();

	private constructor(input: {
		workingDir: string;
		rootDir: string;
		config: ResolvedSkillsConfig;
		userSkillsDir: string;
	}) {
		this.workingDir = input.workingDir;
		this.rootDir = input.rootDir;
		this.config = input.config;
		this.userSkillsDir = input.userSkillsDir;
	}

	static async create(options: SkillsResolverOptions): Promise<SkillsResolver> {
		const env = options.env ?? process.env;
		const workingDir = path.resolve(options.workingDir);
		const rootOverride = toTrimmed(env.CODELIA_AGENTS_ROOT);
		const markers = parseMarkers(env.CODELIA_AGENTS_MARKERS) ?? DEFAULT_MARKERS;
		const rootDir = rootOverride
			? path.resolve(rootOverride)
			: await findRootByMarkers(workingDir, markers);
		const homeDir = toTrimmed(env.HOME) ?? os.homedir();
		const userSkillsDir = path.join(path.resolve(homeDir), ".agents", "skills");
		const resolver = new SkillsResolver({
			workingDir,
			rootDir,
			config: options.config,
			userSkillsDir,
		});
		await resolver.reloadCatalog();
		return resolver;
	}

	private async collectSkillFilesInTree(baseDir: string): Promise<string[]> {
		const collected: string[] = [];
		const walk = async (dirPath: string): Promise<void> => {
			let entries: Dirent<string>[];
			try {
				entries = await fs.readdir(dirPath, {
					withFileTypes: true,
					encoding: "utf8",
				});
			} catch {
				return;
			}
			for (const entry of entries) {
				const entryPath = path.join(dirPath, entry.name);
				if (entry.isDirectory()) {
					await walk(entryPath);
					continue;
				}
				if (entry.isFile() && entry.name === "SKILL.md") {
					collected.push(entryPath);
				}
			}
		};
		await walk(baseDir);
		return collected;
	}

	private async collectRepoSkillFiles(): Promise<string[]> {
		const directories = resolvePathChain(this.rootDir, this.workingDir);
		const skillFiles: string[] = [];
		for (const directoryPath of directories) {
			const skillsRoot = path.join(directoryPath, ".agents", "skills");
			if (!(await exists(skillsRoot))) continue;
			const files = await this.collectSkillFilesInTree(skillsRoot);
			skillFiles.push(...files);
		}
		return skillFiles;
	}

	private async resolveSkillMetadata(
		rawPath: string,
		scope: "repo" | "user",
	): Promise<{ metadata?: SkillMetadata; error?: SkillLoadError }> {
		const normalized = await tryResolvePath(rawPath);
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(normalized.canonical);
		} catch (error) {
			return {
				error: {
					path: normalized.canonical,
					message: `stat failed: ${String(error)}`,
				},
			};
		}
		if (!stat.isFile()) {
			return {
				error: {
					path: normalized.canonical,
					message: "not a regular file",
				},
			};
		}
		let content: string;
		try {
			content = await fs.readFile(normalized.canonical, "utf8");
		} catch (error) {
			return {
				error: {
					path: normalized.canonical,
					message: `read failed: ${String(error)}`,
				},
			};
		}
		const frontmatter = parseFrontmatter(content);
		if (!frontmatter) {
			return {
				error: {
					path: normalized.canonical,
					message: "missing YAML frontmatter",
				},
			};
		}
		const name = frontmatter.name?.trim();
		if (!name || name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
			return {
				error: {
					path: normalized.canonical,
					message:
						"invalid name: expected 1..64 and pattern ^[a-z0-9]+(-[a-z0-9]+)*$",
				},
			};
		}
		const dir = path.dirname(normalized.canonical);
		if (path.basename(dir) !== name) {
			return {
				error: {
					path: normalized.canonical,
					message: "name must match skill directory name",
				},
			};
		}
		const description = frontmatter.description?.trim();
		if (!description || description.length > 1024) {
			return {
				error: {
					path: normalized.canonical,
					message: "invalid description: expected 1..1024 characters",
				},
			};
		}
		return {
			metadata: {
				id: hashPath(normalized.canonical),
				name,
				description,
				path: normalized.canonical,
				dir,
				scope,
				mtime_ms: normalizeMtime(stat.mtimeMs),
			},
		};
	}

	async reloadCatalog(): Promise<SkillCatalog> {
		if (!this.config.enabled) {
			this.catalog = { skills: [], errors: [], truncated: false };
			return this.catalog;
		}

		const files: Array<{ path: string; scope: "repo" | "user" }> = [];
		for (const entry of await this.collectRepoSkillFiles()) {
			files.push({ path: entry, scope: "repo" });
		}
		if (await exists(this.userSkillsDir)) {
			for (const entry of await this.collectSkillFilesInTree(
				this.userSkillsDir,
			)) {
				files.push({ path: entry, scope: "user" });
			}
		}

		const dedup = new Map<string, { path: string; scope: "repo" | "user" }>();
		for (const file of files) {
			const normalized = await tryResolvePath(file.path);
			const previous = dedup.get(normalized.canonical);
			if (!previous || scopeRank(file.scope) < scopeRank(previous.scope)) {
				dedup.set(normalized.canonical, {
					path: normalized.canonical,
					scope: file.scope,
				});
			}
		}

		const skills: SkillMetadata[] = [];
		const errors: SkillLoadError[] = [];
		for (const entry of dedup.values()) {
			const resolved = await this.resolveSkillMetadata(entry.path, entry.scope);
			if (resolved.metadata) {
				skills.push(resolved.metadata);
			} else if (resolved.error) {
				errors.push(resolved.error);
			}
		}

		skills.sort((left, right) => {
			if (left.name !== right.name) return left.name.localeCompare(right.name);
			if (left.scope !== right.scope) {
				return scopeRank(left.scope) - scopeRank(right.scope);
			}
			return left.path.localeCompare(right.path);
		});
		errors.sort((left, right) => left.path.localeCompare(right.path));
		this.catalog = { skills, errors, truncated: false };
		return this.catalog;
	}

	async getCatalog(options?: { forceReload?: boolean }): Promise<SkillCatalog> {
		if (options?.forceReload) {
			return this.reloadCatalog();
		}
		return this.catalog;
	}

	async buildInitialContext(): Promise<string | null> {
		if (!this.config.enabled) return null;
		const catalog = await this.getCatalog();
		if (!catalog.skills.length) return null;

		const skillsXml: string[] = [];
		let bytes = 0;
		let truncated = false;
		for (const skill of catalog.skills) {
			if (skillsXml.length >= this.config.initial.maxEntries) {
				truncated = true;
				break;
			}
			const line = [
				"  <skill>",
				`    <name>${xmlEscape(skill.name)}</name>`,
				`    <description>${xmlEscape(skill.description)}</description>`,
				`    <path>${xmlEscape(skill.path)}</path>`,
				`    <scope>${xmlEscape(skill.scope)}</scope>`,
				"  </skill>",
			].join("\n");
			const nextBytes =
				bytes + (line.length > 0 ? Buffer.byteLength(`${line}\n`, "utf8") : 0);
			if (nextBytes > this.config.initial.maxBytes) {
				truncated = true;
				break;
			}
			skillsXml.push(line);
			bytes = nextBytes;
		}
		const usage = [
			"<skills_usage>",
			"  <about>A skill is a local instruction package defined by a `SKILL.md` file for a specific task/workflow.</about>",
			"  <about>Use skills when the user request matches that workflow, then follow the loaded skill instructions.</about>",
			"  <rule>Treat skills as progressive disclosure. Use `skill_search` for local catalog discovery and `skill_load` for full content.</rule>",
			"  <rule>If the user includes explicit skill mentions (e.g. `$some-skill`), load those skills with `skill_load` before answering.</rule>",
			"  <rule>When a loaded skill defines an explicit workflow or command sequence, follow that skill instruction first.</rule>",
			"  <rule>`skill_load` already returns full `SKILL.md` content. Do not immediately re-read the same `SKILL.md` via `read` or the same output via `tool_output_cache` unless a specific missing detail is required.</rule>",
			"  <rule>After loading a skill, resolve relative paths from that skill directory (`scripts/`, `references/`, `assets/`).</rule>",
			"  <rule>If a loaded skill provides `scripts/`, prefer running or patching those scripts instead of rewriting large blocks manually.</rule>",
			"  <rule>If a loaded skill provides `assets/` or templates, reuse them when applicable.</rule>",
			"  <rule>Load only the specific referenced files needed for the current task.</rule>",
			"  <rule>If the user asks for installable/public/remote skills, do not treat `skill_search` as remote search; follow loaded skill instructions or explicit user instructions for external discovery.</rule>",
			"</skills_usage>",
		];
		const catalogLines = [
			`<skills_catalog scope="initial" truncated="${truncated ? "true" : "false"}">`,
			...skillsXml,
			...(truncated
				? [
						"  <note>Catalog truncated. Use skill_search tool to find additional local skills.</note>",
					]
				: []),
			"</skills_catalog>",
		];
		return [
			"<skills_context>",
			...usage,
			...catalogLines,
			"</skills_context>",
		].join("\n");
	}

	async search(input: {
		query: string;
		limit?: number;
		scope?: "repo" | "user";
	}): Promise<{ results: SkillSearchResult[]; truncated: boolean }> {
		const query = input.query.trim();
		if (!query) {
			return { results: [], truncated: false };
		}
		const catalog = await this.getCatalog();
		const normalizedQuery = query.toLowerCase();
		const queryPathCandidate = path.resolve(this.workingDir, query);
		const queryTokens = new Set(tokenize(normalizedQuery));
		const scored: SkillSearchResult[] = [];
		for (const skill of catalog.skills) {
			if (input.scope && skill.scope !== input.scope) continue;
			const normalizedName = skill.name.toLowerCase();
			const normalizedPath = skill.path.toLowerCase();
			const normalizedQueryPath = queryPathCandidate.toLowerCase();
			if (
				normalizedPath === normalizedQuery ||
				normalizedPath === normalizedQueryPath
			) {
				scored.push({ skill, score: 1000, reason: "exact_path" });
				continue;
			}
			if (normalizedName === normalizedQuery) {
				scored.push({ skill, score: 900, reason: "exact_name" });
				continue;
			}
			if (normalizedName.startsWith(normalizedQuery)) {
				scored.push({ skill, score: 700, reason: "prefix" });
				continue;
			}
			const haystack = new Set(
				tokenize(`${skill.name} ${skill.description}`.toLowerCase()),
			);
			let overlap = 0;
			for (const token of queryTokens) {
				if (haystack.has(token)) {
					overlap += 1;
				}
			}
			if (overlap > 0) {
				scored.push({
					skill,
					score: 100 + overlap,
					reason: "token_overlap",
				});
			}
		}

		scored.sort((left, right) => {
			if (left.score !== right.score) return right.score - left.score;
			if (left.skill.scope !== right.skill.scope) {
				return scopeRank(left.skill.scope) - scopeRank(right.skill.scope);
			}
			return left.skill.path.localeCompare(right.skill.path);
		});

		const defaultLimit = this.config.search.defaultLimit;
		const maxLimit = this.config.search.maxLimit;
		const limit = Math.max(
			1,
			Math.min(maxLimit, Math.trunc(input.limit ?? defaultLimit)),
		);
		const results = scored.slice(0, limit);
		return { results, truncated: scored.length > limit };
	}

	private async listSkillFiles(
		skillDir: string,
	): Promise<{ files: string[]; truncated: boolean }> {
		let rootReal: string;
		try {
			rootReal = await fs.realpath(skillDir);
		} catch {
			rootReal = path.resolve(skillDir);
		}
		const files: string[] = [];
		let bytes = 0;
		let truncated = false;

		const walk = async (dirPath: string): Promise<void> => {
			if (truncated) return;
			let entries: Dirent<string>[];
			try {
				entries = await fs.readdir(dirPath, {
					withFileTypes: true,
					encoding: "utf8",
				});
			} catch {
				return;
			}
			for (const entry of entries) {
				if (truncated) break;
				const entryPath = path.join(dirPath, entry.name);
				if (entry.isSymbolicLink()) {
					continue;
				}
				if (entry.isDirectory()) {
					await walk(entryPath);
					continue;
				}
				if (!entry.isFile()) {
					continue;
				}
				let realPath: string;
				try {
					realPath = await fs.realpath(entryPath);
				} catch {
					realPath = path.resolve(entryPath);
				}
				if (!isWithin(rootReal, realPath)) {
					continue;
				}
				let stat: Awaited<ReturnType<typeof fs.stat>>;
				try {
					stat = await fs.stat(realPath);
				} catch {
					continue;
				}
				if (files.length >= MAX_SKILL_FILES) {
					truncated = true;
					break;
				}
				const nextBytes = bytes + Math.max(0, Math.trunc(stat.size));
				if (nextBytes > MAX_SKILL_FILE_BYTES) {
					truncated = true;
					break;
				}
				files.push(realPath);
				bytes = nextBytes;
			}
		};

		await walk(skillDir);
		files.sort((left, right) => left.localeCompare(right));
		return { files, truncated };
	}

	private async resolveByPath(
		pathInput: string,
	): Promise<SkillMetadata | null> {
		const resolved = path.isAbsolute(pathInput)
			? path.resolve(pathInput)
			: path.resolve(this.workingDir, pathInput);
		const resolvedTry = await tryResolvePath(resolved);
		const byCanonical = this.catalog.skills.find(
			(entry) => entry.path === resolvedTry.canonical,
		);
		if (byCanonical) return byCanonical;
		return (
			this.catalog.skills.find(
				(entry) => entry.path === resolvedTry.resolved,
			) ?? null
		);
	}

	async load(input: {
		name?: string;
		path?: string;
	}): Promise<SkillLoadResult> {
		if (!this.config.enabled) {
			return { ok: false, message: "skills are disabled" };
		}
		await this.getCatalog();
		let selected: SkillMetadata | null = null;
		const pathInput = input.path?.trim();
		const nameInput = input.name?.trim();
		if (pathInput) {
			selected = await this.resolveByPath(pathInput);
			if (!selected) {
				return {
					ok: false,
					message: `skill path not found in catalog: ${pathInput}`,
				};
			}
		} else if (nameInput) {
			const matches = this.catalog.skills.filter(
				(entry) => entry.name === nameInput,
			);
			if (matches.length === 0) {
				return { ok: false, message: `skill not found: ${nameInput}` };
			}
			if (matches.length > 1) {
				return {
					ok: false,
					message: `ambiguous skill name: ${nameInput}`,
					ambiguous_paths: matches.map((entry) => entry.path),
				};
			}
			selected = matches[0];
		} else {
			return { ok: false, message: "name or path is required" };
		}

		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(selected.path);
		} catch (error) {
			return { ok: false, message: `skill file stat failed: ${String(error)}` };
		}
		const mtime = normalizeMtime(stat.mtimeMs);
		const loadedVersion = this.loadedVersions.get(selected.path);
		if (loadedVersion !== undefined && loadedVersion === mtime) {
			return {
				ok: true,
				skill: { ...selected, mtime_ms: mtime },
				already_loaded: true,
				content: `<skill_context_reminder name="${xmlEscape(selected.name)}" path="${xmlEscape(selected.path)}">Skill already loaded in this session. Reuse previous context.</skill_context_reminder>`,
				files: [],
				files_truncated: false,
			};
		}

		let skillBody: string;
		try {
			skillBody = await fs.readFile(selected.path, "utf8");
		} catch (error) {
			return { ok: false, message: `skill file read failed: ${String(error)}` };
		}
		const list = await this.listSkillFiles(selected.dir);
		const filesXml = list.files
			.map((entry) => `<file>${entry}</file>`)
			.join("\n");
		const trailingSlashDir = selected.dir.endsWith(path.sep)
			? selected.dir
			: `${selected.dir}${path.sep}`;
		const content = [
			`<skill_context name="${xmlEscape(selected.name)}" path="${xmlEscape(selected.path)}">`,
			skillBody.trimEnd(),
			"",
			`Base directory: file://${trailingSlashDir.replaceAll("\\", "/")}`,
			"Relative paths in this skill are resolved from this directory.",
			"<skill_files>",
			filesXml,
			"</skill_files>",
			"</skill_context>",
		].join("\n");
		const nextSkill = { ...selected, mtime_ms: mtime };
		this.loadedVersions.set(nextSkill.path, nextSkill.mtime_ms);
		return {
			ok: true,
			skill: nextSkill,
			already_loaded: false,
			content,
			files: list.files,
			files_truncated: list.truncated,
		};
	}

	getSnapshot(): SkillsResolverSnapshot {
		return {
			enabled: this.config.enabled,
			root_dir: this.rootDir,
			working_dir: this.workingDir,
			catalog: this.catalog,
			loaded_versions: [...this.loadedVersions.entries()]
				.map(([skillPath, mtime]) => ({ path: skillPath, mtime_ms: mtime }))
				.sort((left, right) => left.path.localeCompare(right.path)),
		};
	}
}

export const appendInitialSkillsCatalog = (
	systemPrompt: string,
	skillsCatalog: string | null,
): string => {
	if (!skillsCatalog) {
		return systemPrompt;
	}
	return `${systemPrompt}\n\n${skillsCatalog}`;
};
