import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";

class SecurityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecurityError";
	}
}

type SandboxContextInit = {
	sandboxRoot: string;
	sessionDirName: string;
	rootDir: string;
	workingDir: string;
	sessionId: string;
};

export type CleanupSandboxResult = {
	removed: number;
	errors: number;
};

const DEFAULT_SANDBOX_DIR = ".sandbox";
const SESSION_DIR_PREFIX = "session-";
const DEFAULT_SANDBOX_TTL_SECONDS = 12 * 60 * 60;
const MIN_SANDBOX_TTL_SECONDS = 60;
const MAX_SANDBOX_TTL_SECONDS = 30 * 24 * 60 * 60;

const normalizePositiveInt = (value: number, fallback: number): number => {
	if (!Number.isFinite(value)) return fallback;
	const floored = Math.floor(value);
	return floored > 0 ? floored : fallback;
};

const sanitizeSessionSlug = (sessionId: string): string => {
	const normalized = sessionId
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
	if (!normalized) return "session";
	return normalized.slice(0, 32);
};

const toSessionDirName = (sessionId: string): string => {
	const slug = sanitizeSessionSlug(sessionId);
	const hash = crypto
		.createHash("sha1")
		.update(sessionId)
		.digest("hex")
		.slice(0, 12);
	return `${SESSION_DIR_PREFIX}${slug}-${hash}`;
};

const touchDir = async (dirPath: string): Promise<void> => {
	const now = new Date();
	try {
		await fs.utimes(dirPath, now, now);
	} catch {
		// ignore unsupported filesystems
	}
};

export const resolveSandboxRoot = (rootDir?: string): string =>
	rootDir
		? path.resolve(rootDir)
		: path.resolve(process.cwd(), DEFAULT_SANDBOX_DIR);

export const parseSandboxTtlMs = (): number => {
	const parsed = Number(process.env.CODELIA_SANDBOX_TTL_SECONDS);
	const seconds = normalizePositiveInt(parsed, DEFAULT_SANDBOX_TTL_SECONDS);
	const clamped = Math.max(
		MIN_SANDBOX_TTL_SECONDS,
		Math.min(MAX_SANDBOX_TTL_SECONDS, seconds),
	);
	return clamped * 1000;
};

export class SandboxContext {
	readonly sandboxRoot: string;
	readonly sessionDirName: string;
	readonly rootDir: string;
	readonly workingDir: string;
	readonly sessionId: string;

	private constructor(init: SandboxContextInit) {
		this.sandboxRoot = init.sandboxRoot;
		this.sessionDirName = init.sessionDirName;
		this.rootDir = init.rootDir;
		this.workingDir = init.workingDir;
		this.sessionId = init.sessionId;
	}

	static async create(
		sessionId: string,
		rootDir?: string,
	): Promise<SandboxContext> {
		const sandboxRoot = resolveSandboxRoot(rootDir);
		const sessionDirName = toSessionDirName(sessionId);
		const sessionRoot = path.join(sandboxRoot, sessionDirName);
		await fs.mkdir(sessionRoot, { recursive: true });
		await touchDir(sessionRoot);
		return new SandboxContext({
			sandboxRoot,
			sessionDirName,
			rootDir: sessionRoot,
			workingDir: sessionRoot,
			sessionId,
		});
	}

	async touch(): Promise<void> {
		await touchDir(this.rootDir);
	}

	resolvePath(targetPath: string): string {
		const resolved = path.isAbsolute(targetPath)
			? path.resolve(targetPath)
			: path.resolve(this.workingDir, targetPath);
		const relative = path.relative(this.rootDir, resolved);
		if (
			relative === "" ||
			(!relative.startsWith("..") && !path.isAbsolute(relative))
		) {
			return resolved;
		}
		throw new SecurityError(
			`Path escapes sandbox: ${targetPath} -> ${resolved}`,
		);
	}
}

export const cleanupExpiredSandboxDirs = async (
	sandboxRoot: string,
	ttlMs: number,
	activeSessionDirNames: Set<string>,
): Promise<CleanupSandboxResult> => {
	const effectiveTtlMs = Math.max(ttlMs, MIN_SANDBOX_TTL_SECONDS * 1000);
	await fs.mkdir(sandboxRoot, { recursive: true });
	const entries = await fs.readdir(sandboxRoot, { withFileTypes: true });
	const now = Date.now();
	let removed = 0;
	let errors = 0;

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith(SESSION_DIR_PREFIX)) continue;
		if (activeSessionDirNames.has(entry.name)) continue;
		const fullPath = path.join(sandboxRoot, entry.name);
		try {
			const stat = await fs.stat(fullPath);
			if (now - stat.mtimeMs < effectiveTtlMs) continue;
			await fs.rm(fullPath, { recursive: true, force: true });
			removed += 1;
		} catch {
			errors += 1;
		}
	}

	return { removed, errors };
};

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

export type ResolvedPathResult =
	| { ok: true; resolved: string }
	| { ok: false; error: string };

export type SearchPathResult =
	| { ok: true; rootDir: string; searchDir: string }
	| { ok: false; error: string };

export const resolveSandboxPath = async (
	ctx: ToolContext,
	sandboxKey: DependencyKey<SandboxContext>,
	targetPath: string,
): Promise<ResolvedPathResult> => {
	try {
		const sandbox = await getSandboxContext(ctx, sandboxKey);
		return { ok: true, resolved: sandbox.resolvePath(targetPath) };
	} catch (error) {
		return { ok: false, error: `Security error: ${String(error)}` };
	}
};

export const resolveSandboxSearch = async (
	ctx: ToolContext,
	sandboxKey: DependencyKey<SandboxContext>,
	targetPath?: string,
): Promise<SearchPathResult> => {
	try {
		const sandbox = await getSandboxContext(ctx, sandboxKey);
		const searchDir = targetPath
			? sandbox.resolvePath(targetPath)
			: sandbox.workingDir;
		return { ok: true, rootDir: sandbox.rootDir, searchDir };
	} catch (error) {
		return { ok: false, error: `Security error: ${String(error)}` };
	}
};
