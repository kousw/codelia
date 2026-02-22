import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	appendPermissionAllowRules,
	resolveMcpServers,
	resolveReasoningEffort,
	resolveSearchConfig,
	resolveSkillsConfig,
	resolveTextVerbosity,
	resolveTuiConfig,
	updateModel,
	updateTuiTheme,
} from "../src/config";
import { resolveApprovalModeForRuntime } from "../src/permissions/approval-mode";

describe("runtime config resolvers", () => {
	test("resolveReasoningEffort accepts supported values", () => {
		expect(resolveReasoningEffort("low")).toBe("low");
		expect(resolveReasoningEffort("MEDIUM")).toBe("medium");
		expect(resolveReasoningEffort(" high ")).toBe("high");
	});

	test("resolveReasoningEffort rejects unsupported values", () => {
		expect(() => resolveReasoningEffort("minimal")).toThrow(
			"Expected low|medium|high",
		);
	});

	test("resolveTextVerbosity accepts supported values", () => {
		expect(resolveTextVerbosity("low")).toBe("low");
		expect(resolveTextVerbosity("MEDIUM")).toBe("medium");
		expect(resolveTextVerbosity(" high ")).toBe("high");
	});

	test("resolveTextVerbosity rejects unsupported values", () => {
		expect(() => resolveTextVerbosity("verbose")).toThrow(
			"Expected low|medium|high",
		);
	});

	test("resolveMcpServers merges project over global with source", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-mcp-"));
		const restore: Array<[string, string | undefined]> = [];
		const setEnv = (key: string, value: string) => {
			restore.push([key, process.env[key]]);
			process.env[key] = value;
		};
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
		const projectDir = path.join(tempRoot, "project");
		const projectConfigPath = path.join(projectDir, ".codelia", "config.json");
		const globalConfigPath = path.join(
			process.env.XDG_CONFIG_HOME ?? "",
			"codelia",
			"config.json",
		);
		await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.writeFile(
			globalConfigPath,
			`${JSON.stringify(
				{
					version: 1,
					mcp: {
						servers: {
							shared: {
								transport: "http",
								url: "https://global.example.com/mcp",
							},
							globalOnly: {
								transport: "stdio",
								command: "npx",
							},
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		await fs.writeFile(
			projectConfigPath,
			`${JSON.stringify(
				{
					version: 1,
					mcp: {
						servers: {
							shared: {
								transport: "http",
								url: "https://project.example.com/mcp",
								enabled: false,
							},
							projectOnly: {
								transport: "stdio",
								command: "bunx",
								request_timeout_ms: 12_345,
							},
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		try {
			const servers = await resolveMcpServers(projectDir);
			expect(servers).toEqual([
				{
					id: "globalOnly",
					source: "global",
					enabled: true,
					request_timeout_ms: 30000,
					transport: "stdio",
					command: "npx",
				},
				{
					id: "projectOnly",
					source: "project",
					enabled: true,
					request_timeout_ms: 12345,
					transport: "stdio",
					command: "bunx",
				},
				{
					id: "shared",
					source: "project",
					enabled: false,
					request_timeout_ms: 30000,
					transport: "http",
					url: "https://project.example.com/mcp",
				},
			]);
		} finally {
			for (const [key, value] of restore.reverse()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("resolveSkillsConfig merges project over global with defaults", async () => {
		const tempRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-skills-"),
		);
		const restore: Array<[string, string | undefined]> = [];
		const setEnv = (key: string, value: string) => {
			restore.push([key, process.env[key]]);
			process.env[key] = value;
		};
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
		const projectDir = path.join(tempRoot, "project");
		const projectConfigPath = path.join(projectDir, ".codelia", "config.json");
		const globalConfigPath = path.join(
			process.env.XDG_CONFIG_HOME ?? "",
			"codelia",
			"config.json",
		);
		await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.writeFile(
			globalConfigPath,
			`${JSON.stringify(
				{
					version: 1,
					skills: {
						initial: {
							maxEntries: 120,
						},
						search: {
							defaultLimit: 9,
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		await fs.writeFile(
			projectConfigPath,
			`${JSON.stringify(
				{
					version: 1,
					skills: {
						enabled: false,
						initial: {
							maxBytes: 4096,
						},
						search: {
							maxLimit: 20,
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		try {
			expect(await resolveSkillsConfig(projectDir)).toEqual({
				enabled: false,
				initial: {
					maxEntries: 120,
					maxBytes: 4096,
				},
				search: {
					defaultLimit: 9,
					maxLimit: 20,
				},
			});
		} finally {
			for (const [key, value] of restore.reverse()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("updateTuiTheme defaults to global and sticks to project override", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-theme-"));
		const restore: Array<[string, string | undefined]> = [];
		const setEnv = (key: string, value: string) => {
			restore.push([key, process.env[key]]);
			process.env[key] = value;
		};
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
		const projectDir = path.join(tempRoot, "project");
		const projectConfigPath = path.join(projectDir, ".codelia", "config.json");
		const globalConfigPath = path.join(
			process.env.XDG_CONFIG_HOME ?? "",
			"codelia",
			"config.json",
		);
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
		await fs.writeFile(
			projectConfigPath,
			`${JSON.stringify({ version: 1 })}\n`,
		);

		try {
			const firstTarget = await updateTuiTheme(projectDir, "ocean");
			expect(firstTarget.scope).toBe("global");
			const globalRaw = JSON.parse(await fs.readFile(globalConfigPath, "utf8"));
			expect(globalRaw.tui).toEqual({ theme: "ocean" });
			expect(await resolveTuiConfig(projectDir)).toEqual({ theme: "ocean" });

			await fs.writeFile(
				projectConfigPath,
				`${JSON.stringify({ version: 1, tui: { theme: "forest" } })}\n`,
			);
			const secondTarget = await updateTuiTheme(projectDir, "rose");
			expect(secondTarget.scope).toBe("project");
			const projectRaw = JSON.parse(
				await fs.readFile(projectConfigPath, "utf8"),
			);
			expect(projectRaw.tui).toEqual({ theme: "rose" });
			expect(await resolveTuiConfig(projectDir)).toEqual({ theme: "rose" });
		} finally {
			for (const [key, value] of restore.reverse()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("updateModel defaults to global and sticks to project override", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-model-"));
		const restore: Array<[string, string | undefined]> = [];
		const setEnv = (key: string, value: string) => {
			restore.push([key, process.env[key]]);
			process.env[key] = value;
		};
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
		const projectDir = path.join(tempRoot, "project");
		const projectConfigPath = path.join(projectDir, ".codelia", "config.json");
		const globalConfigPath = path.join(
			process.env.XDG_CONFIG_HOME ?? "",
			"codelia",
			"config.json",
		);
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
		await fs.writeFile(
			projectConfigPath,
			`${JSON.stringify({ version: 1 })}\n`,
		);

		try {
			const firstTarget = await updateModel(projectDir, {
				provider: "openai",
				name: "gpt-5.2-codex",
			});
			expect(firstTarget.scope).toBe("global");
			const globalRaw = JSON.parse(await fs.readFile(globalConfigPath, "utf8"));
			expect(globalRaw.model).toEqual({
				provider: "openai",
				name: "gpt-5.2-codex",
			});

			await fs.writeFile(
				projectConfigPath,
				`${JSON.stringify({ version: 1, model: { provider: "anthropic", name: "claude-sonnet" } })}\n`,
			);
			const secondTarget = await updateModel(projectDir, {
				provider: "anthropic",
				name: "claude-opus",
			});
			expect(secondTarget.scope).toBe("project");
			const projectRaw = JSON.parse(
				await fs.readFile(projectConfigPath, "utf8"),
			);
			expect(projectRaw.model).toEqual({
				provider: "anthropic",
				name: "claude-opus",
			});
		} finally {
			for (const [key, value] of restore.reverse()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("appendPermissionAllowRules appends unique rules to project config", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-mcp-"));
		const restore: Array<[string, string | undefined]> = [];
		const setEnv = (key: string, value: string) => {
			restore.push([key, process.env[key]]);
			process.env[key] = value;
		};
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
		const projectDir = path.join(tempRoot, "project");
		const projectConfigPath = path.join(projectDir, ".codelia", "config.json");
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.writeFile(
			projectConfigPath,
			`${JSON.stringify({ version: 1 })}\n`,
		);

		try {
			await appendPermissionAllowRules(projectDir, [
				{ tool: "bash", command: "git status" },
				{ tool: "bash", command: "git status" },
			]);
			const raw = JSON.parse(await fs.readFile(projectConfigPath, "utf8"));
			expect(raw.permissions.allow).toEqual([
				{ tool: "bash", command: "git status" },
			]);
		} finally {
			for (const [key, value] of restore.reverse()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("resolveSearchConfig merges project over global with defaults", async () => {
		const tempRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-search-"),
		);
		const restore: Array<[string, string | undefined]> = [];
		const setEnv = (key: string, value: string) => {
			restore.push([key, process.env[key]]);
			process.env[key] = value;
		};
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
		const projectDir = path.join(tempRoot, "project");
		const projectConfigPath = path.join(projectDir, ".codelia", "config.json");
		const globalConfigPath = path.join(
			process.env.XDG_CONFIG_HOME ?? "",
			"codelia",
			"config.json",
		);
		await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.writeFile(
			globalConfigPath,
			`${JSON.stringify(
				{
					version: 1,
					search: {
						mode: "auto",
						native: {
							providers: ["openai", "anthropic"],
							search_context_size: "high",
						},
						local: {
							backend: "ddg",
							brave_api_key_env: "GLOBAL_BRAVE",
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		await fs.writeFile(
			projectConfigPath,
			`${JSON.stringify(
				{
					version: 1,
					search: {
						mode: "local",
						native: {
							allowed_domains: ["example.com"],
						},
						local: {
							backend: "brave",
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		try {
			expect(await resolveSearchConfig(projectDir)).toEqual({
				mode: "local",
				native: {
					providers: ["openai", "anthropic"],
					searchContextSize: "high",
					allowedDomains: ["example.com"],
				},
				local: {
					backend: "brave",
					braveApiKeyEnv: "GLOBAL_BRAVE",
				},
			});
		} finally {
			for (const [key, value] of restore.reverse()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("resolveApprovalModeForRuntime uses precedence cli > env > project > default > fallback", async () => {
		const previous = process.env.CODELIA_APPROVAL_MODE;
		delete process.env.CODELIA_APPROVAL_MODE;
		const tempRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-approval-runtime-"),
		);
		const restore: Array<[string, string | undefined]> = [];
		const setEnv = (key: string, value: string) => {
			restore.push([key, process.env[key]]);
			process.env[key] = value;
		};
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
		const projectDir = path.join(tempRoot, "workspace", "repo");
		const nestedDir = path.join(projectDir, "packages", "runtime");
		await fs.mkdir(nestedDir, { recursive: true });
		const projectsPath = path.join(
			process.env.XDG_CONFIG_HOME ?? "",
			"codelia",
			"projects.json",
		);
		await fs.mkdir(path.dirname(projectsPath), { recursive: true });

		try {
			const noConfig = await resolveApprovalModeForRuntime({
				workingDir: nestedDir,
				runtimeSandboxRoot: projectDir,
			});
			expect(noConfig.approvalMode).toBe("minimal");
			expect(noConfig.source).toBe("fallback");

			await fs.writeFile(
				projectsPath,
				`${JSON.stringify(
					{
						version: 1,
						default: { approval_mode: "trusted" },
						projects: {
							[projectDir]: { approval_mode: "full-access" },
						},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
			const fromProject = await resolveApprovalModeForRuntime({
				workingDir: nestedDir,
				runtimeSandboxRoot: projectDir,
			});
			expect(fromProject.approvalMode).toBe("full-access");
			expect(fromProject.source).toBe("project");

			await fs.writeFile(
				projectsPath,
				`${JSON.stringify(
					{
						version: 1,
						default: { approval_mode: "trusted" },
						projects: {},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
			const fromDefault = await resolveApprovalModeForRuntime({
				workingDir: nestedDir,
				runtimeSandboxRoot: projectDir,
			});
			expect(fromDefault.approvalMode).toBe("trusted");
			expect(fromDefault.source).toBe("default");

			process.env.CODELIA_APPROVAL_MODE = "minimal";
			const fromEnv = await resolveApprovalModeForRuntime({
				workingDir: nestedDir,
				runtimeSandboxRoot: projectDir,
			});
			expect(fromEnv.approvalMode).toBe("minimal");
			expect(fromEnv.source).toBe("env");

			const originalArgv = [...process.argv];
			try {
				process.argv = ["node", "runtime", "--approval-mode", "full-access"];
				const fromCli = await resolveApprovalModeForRuntime({
					workingDir: nestedDir,
					runtimeSandboxRoot: projectDir,
				});
				expect(fromCli.approvalMode).toBe("full-access");
				expect(fromCli.source).toBe("cli");
			} finally {
				process.argv = originalArgv;
			}
		} finally {
			if (previous === undefined) {
				delete process.env.CODELIA_APPROVAL_MODE;
			} else {
				process.env.CODELIA_APPROVAL_MODE = previous;
			}
			for (const [key, value] of restore.reverse()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
