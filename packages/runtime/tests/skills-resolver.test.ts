import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedSkillsConfig } from "../src/config";
import { SkillsResolver } from "../src/skills";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-skills-"));

const writeText = async (
	targetPath: string,
	content: string,
): Promise<void> => {
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.writeFile(targetPath, content, "utf8");
};

const skillDoc = (
	name: string,
	description: string,
	body = "Use this skill.\n",
) =>
	["---", `name: ${name}`, `description: ${description}`, "---", "", body].join(
		"\n",
	);

const createConfig = (
	overrides: Partial<ResolvedSkillsConfig> = {},
): ResolvedSkillsConfig => ({
	enabled: true,
	initial: {
		maxEntries: 200,
		maxBytes: 32 * 1024,
		...(overrides.initial ?? {}),
	},
	search: {
		defaultLimit: 8,
		maxLimit: 50,
		...(overrides.search ?? {}),
	},
	...overrides,
});

describe("SkillsResolver", () => {
	test("discovers repo/user skills and records invalid SKILL.md errors", async () => {
		const tempRoot = await createTempDir();
		const homeDir = path.join(tempRoot, "home");
		const repoDir = path.join(tempRoot, "repo");
		const cwdDir = path.join(repoDir, "packages", "runtime");
		await writeText(path.join(repoDir, ".git"), "");
		await writeText(
			path.join(repoDir, ".agents", "skills", "repo-review", "SKILL.md"),
			skillDoc("repo-review", "Review changes with risk-first checks."),
		);
		await writeText(
			path.join(repoDir, ".agents", "skills", "invalid", "SKILL.md"),
			skillDoc("wrong-name", "This should fail directory name validation."),
		);
		await writeText(
			path.join(homeDir, ".agents", "skills", "user-helper", "SKILL.md"),
			skillDoc("user-helper", "Local user utility skill."),
		);

		try {
			const resolver = await SkillsResolver.create({
				workingDir: cwdDir,
				config: createConfig(),
				env: {
					...process.env,
					HOME: homeDir,
					CODELIA_AGENTS_MARKERS: ".git",
				},
			});
			const catalog = await resolver.getCatalog();
			expect(catalog.skills.map((entry) => entry.name)).toEqual([
				"repo-review",
				"user-helper",
			]);
			expect(catalog.errors).toHaveLength(1);
			expect(catalog.errors[0].path).toContain(
				"/.agents/skills/invalid/SKILL.md",
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("search and load use deterministic matching and reload suppression", async () => {
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
				config: createConfig(),
				env: {
					...process.env,
					HOME: homeDir,
					CODELIA_AGENTS_MARKERS: ".git",
				},
			});
			const search = await resolver.search({
				query: "release-notes",
				limit: 3,
			});
			expect(search.results).toHaveLength(1);
			expect(search.results[0].reason).toBe("exact_name");

			const first = await resolver.load({ name: "release-notes" });
			expect(first.ok).toBe(true);
			if (!first.ok) throw new Error("unexpected load result");
			expect(first.already_loaded).toBe(false);
			expect(first.content).toContain("<skill_context");

			const second = await resolver.load({ name: "release-notes" });
			expect(second.ok).toBe(true);
			if (!second.ok) throw new Error("unexpected load result");
			expect(second.already_loaded).toBe(true);
			expect(second.content).toContain("skill_context_reminder");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("load by name returns ambiguity error when duplicates exist", async () => {
		const tempRoot = await createTempDir();
		const homeDir = path.join(tempRoot, "home");
		const repoDir = path.join(tempRoot, "repo");
		await writeText(path.join(repoDir, ".git"), "");
		await writeText(
			path.join(repoDir, ".agents", "skills", "dup", "SKILL.md"),
			skillDoc("dup", "Repo duplicate."),
		);
		await writeText(
			path.join(homeDir, ".agents", "skills", "dup", "SKILL.md"),
			skillDoc("dup", "User duplicate."),
		);

		try {
			const resolver = await SkillsResolver.create({
				workingDir: repoDir,
				config: createConfig(),
				env: {
					...process.env,
					HOME: homeDir,
					CODELIA_AGENTS_MARKERS: ".git",
				},
			});
			const result = await resolver.load({ name: "dup" });
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unexpected load result");
			expect(result.message).toContain("ambiguous skill name");
			expect(result.ambiguous_paths).toHaveLength(2);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("buildInitialContext returns structured skills_context XML", async () => {
		const tempRoot = await createTempDir();
		const homeDir = path.join(tempRoot, "home");
		const repoDir = path.join(tempRoot, "repo");
		await writeText(path.join(repoDir, ".git"), "");
		await writeText(
			path.join(repoDir, ".agents", "skills", "repo-review", "SKILL.md"),
			skillDoc("repo-review", "Review changes with risk-first checks."),
		);

		try {
			const resolver = await SkillsResolver.create({
				workingDir: repoDir,
				config: createConfig(),
				env: {
					...process.env,
					HOME: homeDir,
					CODELIA_AGENTS_MARKERS: ".git",
				},
			});
			const initial = await resolver.buildInitialContext();
			expect(initial).not.toBeNull();
			expect(initial).toContain("<skills_context>");
			expect(initial).toContain("<skills_usage>");
			expect(initial).toContain('<skills_catalog scope="initial"');
			expect(initial).toContain("<skill>");
			expect(initial).toContain("<name>repo-review</name>");
			expect(initial).not.toContain("- name:");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
