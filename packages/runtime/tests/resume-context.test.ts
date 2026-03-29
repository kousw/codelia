import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BaseMessage } from "@codelia/core";
import {
	buildResumeDiff,
	injectResumeDiffSystemReminder,
	mergeResumeContextIntoSessionMeta,
	prependCurrentStartupSystemMessage,
	stripResumeDiffSystemMessages,
	stripStartupSystemMessages,
} from "../src/rpc/resume-context";

type MockState = {
	lastUiContext: { workspace_root?: string; cwd?: string } | null;
	agentsResolver: { getRootDir(): string; getSnapshot(): unknown } | null;
	skillsResolver: { getSnapshot(): unknown } | null;
	runtimeWorkingDir: string | null;
	runtimeSandboxRoot: string | null;
	approvalMode: "minimal" | "trusted" | "full-access" | null;
	currentModelProvider: string | null;
	currentModelName: string | null;
	systemPrompt: string | null;
};

const createState = (overrides: Partial<MockState> = {}): MockState => ({
	lastUiContext: {
		workspace_root: "/repo/main",
		cwd: "/repo/main",
	},
	agentsResolver: {
		getRootDir: () => "/repo/main",
		getSnapshot: () => ({
			initialFiles: [
				{ path: "/repo/main/AGENTS.md", mtimeMs: 10, sizeBytes: 1 },
			],
		}),
	},
	skillsResolver: {
		getSnapshot: () => ({
			loaded_versions: [],
		}),
	},
	runtimeWorkingDir: "/repo/main",
	runtimeSandboxRoot: "/repo/main",
	approvalMode: "trusted",
	currentModelProvider: "openai",
	currentModelName: "gpt-test",
	systemPrompt: "current system prompt",
	...overrides,
});

describe("resume-context helpers", () => {
	test("strip startup system messages and re-prepend current system prompt", () => {
		const messages: BaseMessage[] = [
			{ role: "system", content: "base system" },
			{
				role: "system",
				content:
					'<system-reminder type="session.resume.diff">old reminder</system-reminder>',
			},
			{ role: "user", content: "hello" },
		];
		const stripped = stripStartupSystemMessages(
			stripResumeDiffSystemMessages(messages),
		);
		expect(stripped).toEqual([
			{ role: "user", content: "hello" },
		]);
		const restored = prependCurrentStartupSystemMessage(
			stripped,
			"current system",
		);
		expect(restored).toEqual([
			{ role: "system", content: "current system" },
			{ role: "user", content: "hello" },
		]);
		const injected = injectResumeDiffSystemReminder(
			restored,
			'<system-reminder type="session.resume.diff">new reminder</system-reminder>',
		);
		expect(injected).toEqual([
			{ role: "system", content: "current system" },
			{
				role: "system",
				content:
					'<system-reminder type="session.resume.diff">new reminder</system-reminder>',
			},
			{ role: "user", content: "hello" },
		]);
	});

	test("buildResumeDiff reports current context even when no material changes are detected", async () => {
		const state = createState();
		const meta = mergeResumeContextIntoSessionMeta(undefined, state as never);
		const diff = await buildResumeDiff(meta, state as never);
		expect(diff).toBeTruthy();
		expect(diff?.summary).toContain("Current workspace root: /repo/main");
		expect(diff?.summary).toContain("Current approval mode: trusted");
		expect(diff?.summary).toContain("Current model: openai/gpt-test");
		expect(diff?.summary).toContain(
			"No material workspace/AGENTS/skill changes were detected",
		);
		expect(diff?.systemReminder).toContain("session.resume.diff");
		expect(diff?.changed).toBe(false);
	});

	test("buildResumeDiff reports changed workspace and missing loaded skill", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-resume-"));
		try {
			const skillPath = path.join(tempRoot, "skill", "SKILL.md");
			await fs.mkdir(path.dirname(skillPath), { recursive: true });
			await fs.writeFile(skillPath, "# skill\n", "utf8");
			const stat = await fs.stat(skillPath);
			const savedState = createState({
				skillsResolver: {
					getSnapshot: () => ({
						loaded_versions: [
							{ path: skillPath, mtime_ms: Math.trunc(stat.mtimeMs) },
						],
					}),
				},
			});
			const meta = mergeResumeContextIntoSessionMeta(
				undefined,
				savedState as never,
			);
			await fs.rm(skillPath, { force: true });
			const currentState = createState({
				lastUiContext: {
					workspace_root: "/repo/other",
					cwd: "/repo/other",
				},
				agentsResolver: {
					getRootDir: () => "/repo/other",
					getSnapshot: () => ({ initialFiles: [], loadedFiles: [] }),
				},
				runtimeWorkingDir: "/repo/other",
				runtimeSandboxRoot: "/repo/other",
				approvalMode: "full-access",
				currentModelProvider: "anthropic",
				currentModelName: "claude-test",
			});
			const diff = await buildResumeDiff(meta, currentState as never);
			expect(diff).toBeTruthy();
			expect(diff?.summary).toContain(
				"Workspace root changed: /repo/main -> /repo/other",
			);
			expect(diff?.summary).toContain(
				"Approval mode changed: trusted -> full-access",
			);
			expect(diff?.summary).toContain(
				"Model changed: openai/gpt-test -> anthropic/claude-test",
			);
			expect(diff?.summary).toContain("Loaded skill file missing since save:");
			expect(diff?.changed).toBe(true);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("buildResumeDiff does not treat unchanged saved skills as removed after restart", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-resume-skill-stable-"));
		try {
			const savedSkillPath = path.join(tempRoot, "saved", "SKILL.md");
			await fs.mkdir(path.dirname(savedSkillPath), { recursive: true });
			await fs.writeFile(savedSkillPath, "# saved\n", "utf8");
			const savedStat = await fs.stat(savedSkillPath);
			const savedState = createState({
				skillsResolver: {
					getSnapshot: () => ({
						loaded_versions: [
							{ path: savedSkillPath, mtime_ms: Math.trunc(savedStat.mtimeMs) },
						],
					}),
				},
			});
			const meta = mergeResumeContextIntoSessionMeta(undefined, savedState as never);
			const currentState = createState({
				skillsResolver: {
					getSnapshot: () => ({ loaded_versions: [] }),
				},
			});
			const diff = await buildResumeDiff(meta, currentState as never);
			expect(diff).toBeTruthy();
			expect(diff?.summary).not.toContain("Loaded skill file missing since save:");
			expect(diff?.summary).not.toContain("Loaded skill updated in current context:");
			expect(diff?.summary).not.toContain("Loaded skill added in current context:");
			expect(diff?.changed).toBe(false);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("buildResumeDiff treats missing current AGENTS snapshot as unknown in best-effort mode", async () => {
		const savedState = createState({
			agentsResolver: {
				getRootDir: () => "/repo/main",
				getSnapshot: () => ({
					initialFiles: [
						{ path: "/repo/main/AGENTS.md", mtimeMs: 10, sizeBytes: 1 },
					],
				}),
			},
		});
		const meta = mergeResumeContextIntoSessionMeta(undefined, savedState as never);
		const currentState = createState({
			agentsResolver: null,
		});
		const diff = await buildResumeDiff(meta, currentState as never, {
			bestEffortCurrentContext: true,
		});
		expect(diff).toBeTruthy();
		expect(diff?.summary).not.toContain("Initial AGENTS removed from current context:");
		expect(diff?.summary).not.toContain("Initial AGENTS updated:");
		expect(diff?.changed).toBe(false);
	});

	test("buildResumeDiff compares saved and current loaded skill sets", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-resume-skills-"));
		try {
			const savedSkillPath = path.join(tempRoot, "saved", "SKILL.md");
			const currentSkillPath = path.join(tempRoot, "current", "SKILL.md");
			await fs.mkdir(path.dirname(savedSkillPath), { recursive: true });
			await fs.mkdir(path.dirname(currentSkillPath), { recursive: true });
			await fs.writeFile(savedSkillPath, "# saved\n", "utf8");
			await fs.writeFile(currentSkillPath, "# current\n", "utf8");
			const savedStat = await fs.stat(savedSkillPath);
			const currentStat = await fs.stat(currentSkillPath);
			const savedState = createState({
				skillsResolver: {
					getSnapshot: () => ({
						loaded_versions: [
							{ path: savedSkillPath, mtime_ms: Math.trunc(savedStat.mtimeMs) },
						],
					}),
				},
			});
			const meta = mergeResumeContextIntoSessionMeta(
				undefined,
				savedState as never,
			);
			const currentState = createState({
				skillsResolver: {
					getSnapshot: () => ({
						loaded_versions: [
							{ path: currentSkillPath, mtime_ms: Math.trunc(currentStat.mtimeMs) },
						],
					}),
				},
			});
			const diff = await buildResumeDiff(meta, currentState as never);
			expect(diff).toBeTruthy();
			expect(diff?.summary).toContain(
				`Loaded skill added in current context: ${currentSkillPath}`,
			);
			expect(diff?.summary).not.toContain(
				`Loaded skill file missing since save: ${savedSkillPath}`,
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
