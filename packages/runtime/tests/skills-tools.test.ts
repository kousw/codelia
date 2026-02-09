import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DependencyKey, ToolContext } from "@codelia/core";
import type { ResolvedSkillsConfig } from "../src/config";
import { createSkillsResolverKey, SkillsResolver } from "../src/skills";
import { createSkillLoadTool } from "../src/tools/skill-load";
import { createSkillSearchTool } from "../src/tools/skill-search";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-skills-tool-"));

const writeText = async (
	targetPath: string,
	content: string,
): Promise<void> => {
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.writeFile(targetPath, content, "utf8");
};

const createToolContext = (): ToolContext => {
	const cache = new Map<string, unknown>();
	const deps: Record<string, unknown> = Object.create(null);
	return {
		deps,
		resolve: async <T>(key: DependencyKey<T>): Promise<T> => {
			if (cache.has(key.id)) {
				return cache.get(key.id) as T;
			}
			const value = await key.create();
			cache.set(key.id, value);
			return value;
		},
	};
};

const skillDoc = (name: string, description: string) =>
	[
		"---",
		`name: ${name}`,
		`description: ${description}`,
		"---",
		"",
		"body",
	].join("\n");

const baseConfig: ResolvedSkillsConfig = {
	enabled: true,
	initial: {
		maxEntries: 200,
		maxBytes: 32 * 1024,
	},
	search: {
		defaultLimit: 8,
		maxLimit: 50,
	},
};

describe("skill tools", () => {
	test("skill_search returns scored candidates", async () => {
		const tempRoot = await createTempDir();
		const homeDir = path.join(tempRoot, "home");
		const repoDir = path.join(tempRoot, "repo");
		await writeText(path.join(repoDir, ".git"), "");
		await writeText(
			path.join(repoDir, ".agents", "skills", "release-notes", "SKILL.md"),
			skillDoc("release-notes", "Draft release notes from commit history."),
		);
		try {
			const resolver = await SkillsResolver.create({
				workingDir: repoDir,
				config: baseConfig,
				env: {
					...process.env,
					HOME: homeDir,
					CODELIA_AGENTS_MARKERS: ".git",
				},
			});
			const tool = createSkillSearchTool(createSkillsResolverKey(resolver));
			const result = await tool.executeRaw(
				JSON.stringify({ query: "release", limit: 5 }),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as {
				count: number;
				results: Array<{ reason: string; skill: { name: string } }>;
			};
			expect(value.count).toBe(1);
			expect(value.results[0].skill.name).toBe("release-notes");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("skill_load returns full context and supports path input", async () => {
		const tempRoot = await createTempDir();
		const homeDir = path.join(tempRoot, "home");
		const repoDir = path.join(tempRoot, "repo");
		const skillPath = path.join(
			repoDir,
			".agents",
			"skills",
			"repo-review",
			"SKILL.md",
		);
		await writeText(path.join(repoDir, ".git"), "");
		await writeText(
			skillPath,
			skillDoc("repo-review", "Review with a risk-first checklist."),
		);
		try {
			const resolver = await SkillsResolver.create({
				workingDir: repoDir,
				config: baseConfig,
				env: {
					...process.env,
					HOME: homeDir,
					CODELIA_AGENTS_MARKERS: ".git",
				},
			});
			const tool = createSkillLoadTool(createSkillsResolverKey(resolver));
			const result = await tool.executeRaw(
				JSON.stringify({ path: skillPath }),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") throw new Error("unexpected tool result");
			const value = result.value as {
				ok: boolean;
				content?: string;
				skill?: { name: string };
			};
			expect(value.ok).toBe(true);
			expect(value.skill?.name).toBe("repo-review");
			expect(value.content).toContain("<skill_context");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
