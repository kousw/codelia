import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStoragePaths } from "@codelia/storage";
import { AgentsResolver } from "../src/agents";
import { runtimeEnvironmentPresets } from "../src/environment";
import {
	runtimeResourcePolicy,
	runtimeResourceReader,
} from "../src/permissions/runtime-resource-policy";
import { workspaceConfigProtection } from "../src/permissions/workspace-config-paths";
import { RuntimeState } from "../src/runtime-state";
import { SandboxContext } from "../src/sandbox/context";
import { SkillsResolver } from "../src/skills";

test.skipIf(typeof process.geteuid !== "function")(
	"user-owned default and project paths protect startup instructions and skills",
	async () => {
		const tmp = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), "codelia-resource-policy-")),
		);
		const workspace = path.join(tmp, "workspace");
		const globalFile = path.join(workspace, "AGENTS.md");
		const skills = path.join(workspace, ".agents", "skills");
		const privateSkill = path.join(skills, "hidden");
		const ordinarySkill = path.join(skills, "ordinary");
		const env = new Map<string, string | undefined>();
		for (const [key, value] of [
			["CODELIA_LAYOUT", "xdg"],
			["XDG_CONFIG_HOME", path.join(tmp, "config")],
			["XDG_CACHE_HOME", path.join(tmp, "cache")],
			["XDG_STATE_HOME", path.join(tmp, "state")],
		]) {
			env.set(key, process.env[key]);
			process.env[key] = value;
		}
		try {
			await Promise.all(
				[privateSkill, ordinarySkill].map((directory) =>
					fs.mkdir(directory, { recursive: true }),
				),
			);
			await fs.writeFile(globalFile, "hidden startup fixture\n");
			await fs.writeFile(
				path.join(privateSkill, "SKILL.md"),
				"---\nname: hidden\ndescription: hidden catalog fixture\n---\n",
			);
			await fs.writeFile(
				path.join(ordinarySkill, "SKILL.md"),
				"---\nname: ordinary\ndescription: ordinary catalog fixture\n---\n",
			);
			await fs.mkdir(path.join(workspace, ".codelia"));
			// Workspace policy files are ordinary local data, not a policy source.
			await fs.writeFile(
				path.join(workspace, ".codelia", "projects.json"),
				'{"version":1,"default":{"protected_paths":[]}}',
			);
			const storage = resolveStoragePaths();
			await fs.mkdir(storage.configDir, { recursive: true });
			await fs.writeFile(
				storage.projectsFile,
				JSON.stringify({
					version: 1,
					default: { protected_paths: [globalFile] },
					projects: {
						[workspace]: { protected_paths: [privateSkill, globalFile] },
					},
				}),
				{ mode: 0o600 },
			);

			const state = new RuntimeState();
			state.runtimeSandboxRoot = workspace;
			const policy = await runtimeResourcePolicy(state, workspace);
			expect(policy.protectedPaths).toEqual([globalFile, privateSkill]);
			expect(
				(
					await runtimeResourcePolicy(
						new RuntimeState(),
						path.join(tmp, "future-workspace"),
					)
				).protectedPaths,
			).toEqual([globalFile]);
			const reader = await runtimeResourceReader(state, workspace);
			const agents = await AgentsResolver.create(
				workspace,
				undefined,
				undefined,
				reader,
			);
			expect(agents.buildInitialContext()).toBeNull();
			expect(await agents.resolveForPath(workspace)).toEqual([]);
			const resolver = await SkillsResolver.create({
				workingDir: workspace,
				reader,
				env: { ...process.env, HOME: tmp },
				config: {
					enabled: true,
					initial: { maxEntries: 20, maxBytes: 4096 },
					search: { defaultLimit: 8, maxLimit: 20 },
				},
			});
			expect(
				(await resolver.getCatalog()).skills.map((skill) => skill.name),
			).toEqual(["ordinary"]);
			expect(
				(await resolver.load({ path: path.join(privateSkill, "SKILL.md") })).ok,
			).toBe(false);

			await fs.chmod(storage.projectsFile, 0o666);
			await expect(
				runtimeResourcePolicy(new RuntimeState(), workspace),
			).rejects.toThrow("untrusted_projects_policy");
		} finally {
			for (const [key, original] of env) {
				if (original === undefined) delete process.env[key];
				else process.env[key] = original;
			}
			await fs.rm(tmp, { recursive: true, force: true });
		}
	},
);

test("SDK resource policy honors an explicit host path with ordinary reads available", async () => {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "codelia-host-file-policy-")),
	);
	try {
		const restricted = path.join(root, "restricted.txt");
		const ordinary = path.join(root, ".env");
		await Promise.all([
			fs.writeFile(restricted, "restricted fixture"),
			fs.writeFile(ordinary, "ordinary fixture"),
		]);
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			environment: {
				contract: {
					...runtimeEnvironmentPresets["tui-local"],
					workspace: { root, filesystem: "enabled", process: "runtime" },
				},
			},
			adapters: { approvalProtectedPaths: [restricted] },
		});
		const reader = await runtimeResourceReader(state, root);
		expect(await reader.readText(ordinary)).toBe("ordinary fixture");
		await expect(reader.readText(restricted)).rejects.toThrow(
			"Path is protected",
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")(
	"dangling project configuration links reserve their target and leave ordinary reads available",
	async () => {
		const root = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), "codelia-dangling-config-")),
		);
		try {
			const config = path.join(root, ".codelia");
			const absent = path.join(root, "future-policy.json");
			await fs.mkdir(config);
			await fs.symlink(
				"../future-policy.json",
				path.join(config, "config.json"),
			);
			await fs.writeFile(path.join(root, "notes.txt"), "fixture");
			expect(workspaceConfigProtection(root).readOnlyPaths).toContain(absent);
			const reader = await runtimeResourceReader(new RuntimeState(), root);
			expect(await reader.readText(path.join(root, "notes.txt"))).toBe(
				"fixture",
			);
			await fs.writeFile(absent, '{"version":1}');
			expect(workspaceConfigProtection(root).readOnlyAliasPaths).toEqual([
				absent,
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);

test.skipIf(typeof process.geteuid !== "function")(
	"a large home workspace starts with its verified sandbox mode and private paths",
	async () => {
		const root = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), "codelia-home-workspace-")),
		);
		try {
			const dir = path.join(root, ".codelia");
			await fs.mkdir(dir, { mode: 0o700 });
			const hidden = path.join(root, "fixture-private.txt");
			const ordinary = path.join(root, "notes.txt");
			const checkout = path.join(dir, "worktrees", "old-lane");
			await fs.mkdir(checkout, { recursive: true });
			for (let start = 0; start <= 8192; start += 128) {
				await Promise.all(
					Array.from({ length: 128 }, (_, index) =>
						fs.writeFile(path.join(checkout, `${start + index}.txt`), ""),
					),
				);
			}
			await Promise.all([
				fs.writeFile(hidden, "private fixture"),
				fs.writeFile(ordinary, "ordinary fixture"),
				fs.writeFile(
					path.join(dir, "projects.json"),
					JSON.stringify({
						version: 1,
						default: { protected_paths: [hidden] },
						projects: { [root]: { sandbox_mode: "readonly" } },
					}),
					{ mode: 0o600 },
				),
			]);
			const protectedContext = await SandboxContext.create(root, {
				protectResources: true,
				sandboxMode: "workspace-write",
			});
			expect(protectedContext.resolvePath(ordinary, "write")).toBe(ordinary);
			expect(() =>
				protectedContext.resolvePath(path.join(checkout, "0.txt"), "write"),
			).toThrow("Path is read-only");
			const env = {
				PATH: process.env.PATH ?? "",
				HOME: root,
				USERPROFILE: root,
				CODELIA_LAYOUT: "home",
				CODELIA_SANDBOX_ROOT: root,
				CODELIA_CONFIG_PATH: path.join(dir, "config.json"),
			};
			// Bun fixes homedir at process startup, so exercise the reader in a child.
			const readerCheck = Bun.spawnSync({
				cwd: path.resolve(import.meta.dir, ".."),
				env,
				cmd: [
					process.execPath,
					"-e",
					`import { runtimeResourceReader } from "./src/permissions/runtime-resource-policy";
					import { RuntimeState } from "./src/runtime-state";
					const reader = await runtimeResourceReader(new RuntimeState(), process.env.HOME);
					console.log(await reader.readText(process.argv[1]));
					try {
						await reader.readText(process.argv[2]);
						throw new Error("Expected the fixture to be private");
					} catch (error) {
						if (!error.message.includes("Path is protected")) throw error;
					}`,
					ordinary,
					hidden,
				],
			});
			expect(readerCheck.stderr.toString()).toBe("");
			expect(readerCheck.exitCode).toBe(0);
			expect(readerCheck.stdout.toString().trim()).toBe("ordinary fixture");
			const runtime = Bun.spawn({
				cmd: [
					process.execPath,
					path.resolve(import.meta.dir, "../src/index.ts"),
				],
				cwd: root,
				env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			const stderr = new Response(runtime.stderr).text();
			const reader = runtime.stdout.getReader();
			try {
				runtime.stdin.write(
					`${JSON.stringify({
						jsonrpc: "2.0",
						id: "test-startup",
						method: "initialize",
						params: { client: { name: "test", version: "1" } },
					})}\n`,
				);
				runtime.stdin.flush();
				const result = await Promise.race([
					(async () => {
						let data = "";
						const decoder = new TextDecoder();
						for (;;) {
							const { done, value } = await reader.read();
							if (done) return "";
							data += decoder.decode(value, { stream: true });
							const newline = data.indexOf("\n");
							if (newline >= 0) return data.slice(0, newline);
						}
					})(),
					Bun.sleep(2500).then(() => ""),
				]);
				expect(result).not.toBe("");
				expect(JSON.parse(result)).toMatchObject({
					id: "test-startup",
					result: { sandbox_mode: { value: "readonly", source: "project" } },
				});
			} finally {
				runtime.stdin.end();
				await reader.cancel();
				if (
					(await Promise.race([
						runtime.exited,
						Bun.sleep(500).then(() => null),
					])) === null
				)
					runtime.kill();
				await runtime.exited;
			}
			expect(await stderr).not.toContain("agents resolver startup init failed");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	10_000,
);
