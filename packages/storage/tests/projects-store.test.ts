import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	isSameConfigFilePath,
	ProjectsPolicyStore,
	resolveStoragePaths,
} from "../src";

describe("ProjectsPolicyStore", () => {
	test("resolveStoragePaths includes projects file", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-storage-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			expect(paths.projectsFile).toBe(path.join(root, "projects.json"));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("save/load roundtrip keeps valid approval policy entries", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-projects-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			const store = new ProjectsPolicyStore(paths);
			await store.save({
				version: 1,
				default: { approval_mode: "minimal" },
				projects: {
					"/repo/a": { approval_mode: "trusted" },
				},
			});
			const loaded = await store.load();
			expect(loaded).toEqual({
				version: 1,
				default: { approval_mode: "minimal" },
				projects: {
					"/repo/a": { approval_mode: "trusted" },
				},
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("legacy projects files remain usable when owner verification is unavailable", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-projects-"));
		const owner = process.geteuid;
		try {
			const paths = resolveStoragePaths({
				rootOverride: path.join(root, "config"),
			});
			const workspace = path.join(root, "workspace");
			const store = new ProjectsPolicyStore(paths);
			process.geteuid = undefined;
			await expect(
				store.loadUserOwned(workspace, { strict: true }),
			).resolves.toBeNull();
			await store.save({ version: 1, default: { approval_mode: "trusted" } });
			await expect(
				store.loadUserOwned(workspace, { strict: true }),
			).resolves.toBeNull();
			await store.save({
				version: 1,
				projects: {
					[path.join(root, "different-workspace")]: {
						protected_paths: [path.join(root, "private.txt")],
					},
				},
			});
			await expect(
				store.loadUserOwned(workspace, { strict: true }),
			).resolves.toBeNull();
			for (const policy of [
				{ default: { protected_paths: [path.join(root, "private.txt")] } },
				{
					projects: {
						[workspace]: { protected_paths: [path.join(root, "private.txt")] },
					},
				},
			]) {
				await store.save({ version: 1, ...policy });
				await expect(
					store.loadUserOwned(workspace, { strict: true }),
				).rejects.toThrow("protected_paths_owner_verification_unavailable");
			}
		} finally {
			process.geteuid = owner;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("load throws for invalid approval mode entries", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-projects-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			await fs.mkdir(path.dirname(paths.projectsFile), { recursive: true });
			await fs.writeFile(
				paths.projectsFile,
				JSON.stringify(
					{
						version: 1,
						default: { approval_mode: "not-valid" },
						projects: {
							"/repo/a": { approval_mode: "trusted" },
						},
					},
					null,
					2,
				),
				"utf8",
			);
			const store = new ProjectsPolicyStore(paths);
			await expect(store.load()).rejects.toThrow(
				"projects policy default.approval_mode is invalid",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("load throws for invalid JSON", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-projects-"));
		try {
			const paths = resolveStoragePaths({ rootOverride: root });
			await fs.mkdir(path.dirname(paths.projectsFile), { recursive: true });
			await fs.writeFile(paths.projectsFile, '{"version":1', "utf8");
			const store = new ProjectsPolicyStore(paths);
			await expect(store.load()).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test.skipIf(typeof process.geteuid !== "function")(
		"home workspace allows owner-verified default policy writes and rejects redirects or nested checkouts",
		async () => {
			const home = await fs.realpath(
				await fs.mkdtemp(path.join(os.tmpdir(), "codelia-home-policy-")),
			);
			const nestedRepo = path.join(home, "work", "repo");
			const redirectTarget = path.join(home, "redirected-config");
			try {
				await fs.mkdir(nestedRepo, { recursive: true, mode: 0o700 });
				await fs.mkdir(redirectTarget, { recursive: true, mode: 0o700 });
				const check = Bun.spawnSync({
					cwd: path.resolve(import.meta.dir, ".."),
					env: {
						PATH: process.env.PATH ?? "",
						HOME: home,
						USERPROFILE: home,
						CODELIA_LAYOUT: "home",
					},
					cmd: [
						process.execPath,
						"-e",
						`import { promises as fs } from "node:fs";
						import path from "node:path";
						import { ProjectsPolicyStore } from "./src";
						const home = process.argv[1];
						const nestedRepo = process.argv[2];
						const redirectTarget = process.argv[3];
						const store = new ProjectsPolicyStore();
						await store.writeProjectMode(home, "readonly");
						const remembered = await store.updateRememberedTool(home, "webfetch", true);
						if (!remembered) throw new Error("Expected remembered tool write");
						const loaded = await store.loadUserOwned(home, { strict: true });
						if (loaded?.projects?.[home]?.sandbox_mode !== "readonly")
							throw new Error("Expected readonly home mode");
						if (loaded?.projects?.[home]?.remembered_tool_allows?.[0]?.tool !== "webfetch")
							throw new Error("Expected remembered webfetch tool for home");
						if (loaded?.projects?.[nestedRepo] !== undefined)
							throw new Error("Home policy must not populate nested repo");
						// Symlinked ~/.codelia must be rejected for both reads and writes.
						await fs.rm(path.join(home, ".codelia"), { recursive: true, force: true });
						await fs.symlink(redirectTarget, path.join(home, ".codelia"));
						let rejectedRedirect = false;
						try {
							await store.writeProjectMode(home, "workspace-write");
						} catch (error) {
							rejectedRedirect = String(error).includes("unsafe_projects_policy_path");
						}
						if (!rejectedRedirect) throw new Error("Expected symlink redirect rejection");
						// Default XDG layout under ~/.config/codelia is also permitted in home.
						await fs.rm(path.join(home, ".codelia"), { recursive: true, force: true });
						process.env.CODELIA_LAYOUT = "xdg";
						delete process.env.XDG_CONFIG_HOME;
						const defaultXdgStore = new ProjectsPolicyStore();
						await defaultXdgStore.writeProjectMode(home, "readonly");
						const loadedXdg = await defaultXdgStore.loadUserOwned(home, { strict: true });
						if (loadedXdg?.projects?.[home]?.sandbox_mode !== "readonly")
							throw new Error("Expected default XDG home write to succeed");
						// Non-default XDG_CONFIG_HOME pointing inside ~ (e.g. a custom dir) preserves
						// existing owner-verified read compatibility (e.g. stored readonly) while rejecting writes.
						const customXdgDir = path.join(nestedRepo, ".config", "codelia");
						await fs.mkdir(customXdgDir, { recursive: true, mode: 0o700 });
						await fs.writeFile(
							path.join(customXdgDir, "projects.json"),
							JSON.stringify({
								version: 1,
								projects: { [home]: { sandbox_mode: "readonly" } },
							}),
							{ mode: 0o600 },
						);
						process.env.XDG_CONFIG_HOME = path.join(nestedRepo, ".config");
						const customHomeXdgStore = new ProjectsPolicyStore();
						const loadedCustomXdg = await customHomeXdgStore.loadUserOwned(home, { strict: true });
						if (loadedCustomXdg?.projects?.[home]?.sandbox_mode !== "readonly")
							throw new Error("Expected custom XDG home read to preserve stored readonly policy");
						let rejectedCustomHomeXdg = false;
						try {
							await customHomeXdgStore.writeProjectMode(home, "workspace-write");
						} catch (error) {
							rejectedCustomHomeXdg = String(error).includes("unsafe_projects_policy_path");
						}
						if (!rejectedCustomHomeXdg)
							throw new Error("Expected non-default XDG_CONFIG_HOME write inside ~ to be rejected");
						// Non-home workspace overlap via XDG_CONFIG_HOME inside nestedRepo must be rejected.
						const nestedStore = new ProjectsPolicyStore();
						let rejectedNested = false;
						try {
							await nestedStore.writeProjectMode(nestedRepo, "readonly");
						} catch (error) {
							rejectedNested = String(error).includes("unsafe_projects_policy_path");
						}
						if (!rejectedNested) throw new Error("Expected nested workspace overlap rejection");`,
						home,
						nestedRepo,
						redirectTarget,
					],
				});
				expect(check.stderr.toString()).toBe("");
				expect(check.exitCode).toBe(0);
			} finally {
				await fs.rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"isSameConfigFilePath treats hard-linked config files as the same file",
		async () => {
			const root = await fs.realpath(
				await fs.mkdtemp(path.join(os.tmpdir(), "codelia-hardlink-cfg-")),
			);
			const globalFile = path.join(root, "global.json");
			const linkedFile = path.join(root, "project-config.json");
			const distinctFile = path.join(root, "other.json");
			try {
				await fs.writeFile(globalFile, '{"version":1}\n');
				await fs.link(globalFile, linkedFile);
				await fs.writeFile(distinctFile, '{"version":1}\n');
				expect(isSameConfigFilePath(globalFile, linkedFile)).toBe(true);
				expect(isSameConfigFilePath(globalFile, distinctFile)).toBe(false);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);
});
