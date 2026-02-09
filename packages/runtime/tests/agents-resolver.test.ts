import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentsResolver } from "../src/agents";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-agents-"));

const writeText = async (
	targetPath: string,
	content: string,
): Promise<void> => {
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.writeFile(targetPath, content, "utf8");
};

const createEnv = (
	overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete env[key];
		} else {
			env[key] = value;
		}
	}
	return env;
};

describe("AgentsResolver", () => {
	test("loads initial AGENTS chain from inferred root to cwd", async () => {
		const tempRoot = await createTempDir();
		const rootDir = path.join(tempRoot, "repo");
		const cwdDir = path.join(rootDir, "packages", "runtime");
		const rootAgentsPath = path.join(rootDir, "AGENTS.md");
		const packagesAgentsPath = path.join(rootDir, "packages", "AGENTS.md");
		await writeText(path.join(rootDir, ".codelia", "config.json"), "{}\n");
		await writeText(rootAgentsPath, "root instructions\n");
		await writeText(packagesAgentsPath, "packages instructions\n");
		await fs.mkdir(cwdDir, { recursive: true });

		try {
			const resolver = await AgentsResolver.create(
				cwdDir,
				undefined,
				createEnv({
					CODELIA_AGENTS_ROOT: undefined,
					CODELIA_AGENTS_MARKERS: ".codelia,.git,.jj",
				}),
			);
			const initial = resolver.buildInitialContext();
			expect(resolver.getRootDir()).toBe(rootDir);
			expect(initial).not.toBeNull();
			const rootIndex = (initial ?? "").indexOf(
				`Instructions from: ${rootAgentsPath}`,
			);
			const packagesIndex = (initial ?? "").indexOf(
				`Instructions from: ${packagesAgentsPath}`,
			);
			expect(rootIndex).toBeGreaterThanOrEqual(0);
			expect(packagesIndex).toBeGreaterThan(rootIndex);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("resolveForPath reports only newly discovered AGENTS once", async () => {
		const tempRoot = await createTempDir();
		const rootDir = path.join(tempRoot, "repo");
		const cwdDir = path.join(rootDir, "src");
		const featureDir = path.join(rootDir, "src", "feature");
		const targetFile = path.join(featureDir, "index.ts");
		const featureAgentsPath = path.join(featureDir, "AGENTS.md");
		await writeText(path.join(rootDir, ".git"), "");
		await writeText(path.join(rootDir, "AGENTS.md"), "root instructions\n");
		await writeText(featureAgentsPath, "feature instructions\n");
		await writeText(targetFile, "export const value = 1;\n");
		await fs.mkdir(cwdDir, { recursive: true });

		try {
			const resolver = await AgentsResolver.create(
				cwdDir,
				undefined,
				createEnv({ CODELIA_AGENTS_MARKERS: ".git" }),
			);
			const first = await resolver.resolveForPath(targetFile);
			expect(first).toHaveLength(1);
			expect(first[0]).toMatchObject({
				path: featureAgentsPath,
				reason: "new",
			});

			const second = await resolver.resolveForPath(targetFile);
			expect(second).toHaveLength(0);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("resolveForPath reports updated AGENTS when mtime changes", async () => {
		const tempRoot = await createTempDir();
		const rootDir = path.join(tempRoot, "repo");
		const cwdDir = path.join(rootDir, "src");
		const rootAgentsPath = path.join(rootDir, "AGENTS.md");
		const targetFile = path.join(cwdDir, "index.ts");
		await writeText(path.join(rootDir, ".git"), "");
		await writeText(rootAgentsPath, "root instructions\n");
		await writeText(targetFile, "export const value = 1;\n");

		try {
			const resolver = await AgentsResolver.create(
				cwdDir,
				undefined,
				createEnv({ CODELIA_AGENTS_MARKERS: ".git" }),
			);
			expect(await resolver.resolveForPath(targetFile)).toHaveLength(0);

			await new Promise((resolve) => setTimeout(resolve, 10));
			await writeText(rootAgentsPath, "root instructions updated\n");

			const updated = await resolver.resolveForPath(targetFile);
			expect(updated).toHaveLength(1);
			expect(updated[0]).toMatchObject({
				path: rootAgentsPath,
				reason: "updated",
			});
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
