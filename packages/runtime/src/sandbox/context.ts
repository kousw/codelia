import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";

export class SecurityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecurityError";
	}
}

type SandboxContextInit = {
	rootDir: string;
	workingDir: string;
	sessionId: string;
};

export class SandboxContext {
	readonly rootDir: string;
	readonly workingDir: string;
	readonly sessionId: string;

	private constructor(init: SandboxContextInit) {
		this.rootDir = init.rootDir;
		this.workingDir = init.workingDir;
		this.sessionId = init.sessionId;
	}

	static async create(rootDir?: string): Promise<SandboxContext> {
		const sessionId = crypto.randomUUID().slice(0, 8);
		const root = rootDir ? path.resolve(rootDir) : process.cwd();
		await fs.mkdir(root, { recursive: true });
		return new SandboxContext({
			rootDir: root,
			workingDir: root,
			sessionId,
		});
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
