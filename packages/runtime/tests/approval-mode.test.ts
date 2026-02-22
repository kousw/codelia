import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStoragePaths } from "@codelia/storage";
import {
	resolveApprovalModeForRuntime,
	resolveProjectPolicyKey,
} from "../src/permissions/approval-mode";

const withTempStorageEnv = async () => {
	const tempRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-approval-"),
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
	await fs.mkdir(projectDir, { recursive: true });

	return {
		tempRoot,
		projectDir,
		cleanup: async () => {
			for (const [key, value] of restore.reverse()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		},
	};
};

const withArgv = async (argv: string[], run: () => Promise<void>) => {
	const original = [...process.argv];
	process.argv = argv;
	try {
		await run();
	} finally {
		process.argv = original;
	}
};

describe("approval mode resolution", () => {
	test("falls back to minimal when no source is configured", async () => {
		const env = await withTempStorageEnv();
		try {
			const result = await resolveApprovalModeForRuntime({
				workingDir: env.projectDir,
				runtimeSandboxRoot: env.projectDir,
			});
			expect(result.approvalMode).toBe("minimal");
			expect(result.source).toBe("fallback");
		} finally {
			await env.cleanup();
		}
	});

	test("uses startup selection when unresolved and persists project mode", async () => {
		const env = await withTempStorageEnv();
		try {
			const storagePaths = resolveStoragePaths();
			const key = await resolveProjectPolicyKey(env.projectDir, env.projectDir);
			const result = await resolveApprovalModeForRuntime({
				workingDir: env.projectDir,
				runtimeSandboxRoot: env.projectDir,
				requestStartupSelection: async () => "trusted",
			});
			expect(result.approvalMode).toBe("trusted");
			expect(result.source).toBe("startup-selection");
			const saved = JSON.parse(
				await fs.readFile(storagePaths.projectsFile, "utf8"),
			) as {
				projects?: Record<string, { approval_mode?: string }>;
			};
			expect(saved.projects?.[key]?.approval_mode).toBe("trusted");
		} finally {
			await env.cleanup();
		}
	});

	test("startup selection can decline and fallback stays minimal", async () => {
		const env = await withTempStorageEnv();
		try {
			const storagePaths = resolveStoragePaths();
			const result = await resolveApprovalModeForRuntime({
				workingDir: env.projectDir,
				runtimeSandboxRoot: env.projectDir,
				requestStartupSelection: async () => null,
			});
			expect(result.approvalMode).toBe("minimal");
			expect(result.source).toBe("fallback");
			await expect(
				fs.readFile(storagePaths.projectsFile, "utf8"),
			).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await env.cleanup();
		}
	});

	test("uses env mode when cli flag is missing", async () => {
		const env = await withTempStorageEnv();
		const previous = process.env.CODELIA_APPROVAL_MODE;
		process.env.CODELIA_APPROVAL_MODE = "trusted";
		try {
			const result = await resolveApprovalModeForRuntime({
				workingDir: env.projectDir,
				runtimeSandboxRoot: env.projectDir,
			});
			expect(result.approvalMode).toBe("trusted");
			expect(result.source).toBe("env");
		} finally {
			if (previous === undefined) {
				delete process.env.CODELIA_APPROVAL_MODE;
			} else {
				process.env.CODELIA_APPROVAL_MODE = previous;
			}
			await env.cleanup();
		}
	});

	test("throws explicit error for invalid env approval mode", async () => {
		const env = await withTempStorageEnv();
		const previous = process.env.CODELIA_APPROVAL_MODE;
		process.env.CODELIA_APPROVAL_MODE = "danger";
		try {
			await expect(
				resolveApprovalModeForRuntime({
					workingDir: env.projectDir,
					runtimeSandboxRoot: env.projectDir,
				}),
			).rejects.toThrow("Invalid CODELIA_APPROVAL_MODE");
		} finally {
			if (previous === undefined) {
				delete process.env.CODELIA_APPROVAL_MODE;
			} else {
				process.env.CODELIA_APPROVAL_MODE = previous;
			}
			await env.cleanup();
		}
	});

	test("cli flag has highest precedence", async () => {
		const env = await withTempStorageEnv();
		const previous = process.env.CODELIA_APPROVAL_MODE;
		process.env.CODELIA_APPROVAL_MODE = "minimal";
		try {
			await withArgv(
				["node", "runtime", "--approval-mode", "full-access"],
				async () => {
					const result = await resolveApprovalModeForRuntime({
						workingDir: env.projectDir,
						runtimeSandboxRoot: env.projectDir,
					});
					expect(result.approvalMode).toBe("full-access");
					expect(result.source).toBe("cli");
				},
			);
		} finally {
			if (previous === undefined) {
				delete process.env.CODELIA_APPROVAL_MODE;
			} else {
				process.env.CODELIA_APPROVAL_MODE = previous;
			}
			await env.cleanup();
		}
	});

	test("throws explicit error for invalid cli approval mode", async () => {
		const env = await withTempStorageEnv();
		try {
			await withArgv(
				["node", "runtime", "--approval-mode", "danger"],
				async () => {
					await expect(
						resolveApprovalModeForRuntime({
							workingDir: env.projectDir,
							runtimeSandboxRoot: env.projectDir,
						}),
					).rejects.toThrow("Invalid --approval-mode");
				},
			);
		} finally {
			await env.cleanup();
		}
	});

	test("reads project and default from projects.json", async () => {
		const env = await withTempStorageEnv();
		try {
			const storagePaths = resolveStoragePaths();
			await fs.mkdir(path.dirname(storagePaths.projectsFile), {
				recursive: true,
			});
			const key = await resolveProjectPolicyKey(env.projectDir, env.projectDir);
			await fs.writeFile(
				storagePaths.projectsFile,
				`${JSON.stringify(
					{
						version: 1,
						default: { approval_mode: "trusted" },
						projects: {
							[key]: { approval_mode: "full-access" },
						},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
			const result = await resolveApprovalModeForRuntime({
				workingDir: env.projectDir,
				runtimeSandboxRoot: env.projectDir,
			});
			expect(result.approvalMode).toBe("full-access");
			expect(result.source).toBe("project");

			await fs.writeFile(
				storagePaths.projectsFile,
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
			const fallbackToDefault = await resolveApprovalModeForRuntime({
				workingDir: env.projectDir,
				runtimeSandboxRoot: env.projectDir,
			});
			expect(fallbackToDefault.approvalMode).toBe("trusted");
			expect(fallbackToDefault.source).toBe("default");
		} finally {
			await env.cleanup();
		}
	});

	test("project key uses sandbox root so subdirectories resolve to same project entry", async () => {
		const env = await withTempStorageEnv();
		try {
			const storagePaths = resolveStoragePaths();
			await fs.mkdir(path.dirname(storagePaths.projectsFile), {
				recursive: true,
			});
			const sandboxRoot = env.projectDir;
			const nestedWorkingDir = path.join(env.projectDir, "packages", "runtime");
			await fs.mkdir(nestedWorkingDir, { recursive: true });
			const key = await resolveProjectPolicyKey(nestedWorkingDir, sandboxRoot);
			await fs.writeFile(
				storagePaths.projectsFile,
				`${JSON.stringify(
					{
						version: 1,
						projects: {
							[key]: { approval_mode: "trusted" },
						},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
			const result = await resolveApprovalModeForRuntime({
				workingDir: nestedWorkingDir,
				runtimeSandboxRoot: sandboxRoot,
			});
			expect(result.approvalMode).toBe("trusted");
			expect(result.source).toBe("project");
		} finally {
			await env.cleanup();
		}
	});

	test("throws explicit error when projects.json is invalid", async () => {
		const env = await withTempStorageEnv();
		try {
			const storagePaths = resolveStoragePaths();
			await fs.mkdir(path.dirname(storagePaths.projectsFile), {
				recursive: true,
			});
			await fs.writeFile(storagePaths.projectsFile, '{"version":1', "utf8");
			await expect(
				resolveApprovalModeForRuntime({
					workingDir: env.projectDir,
					runtimeSandboxRoot: env.projectDir,
				}),
			).rejects.toThrow("Failed to load approval mode policy");
		} finally {
			await env.cleanup();
		}
	});
});
