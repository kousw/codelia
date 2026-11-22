import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@codelia/config-loader";
import { resolveTopLevelAction } from "../src/basic-options";
import { runUpdateCommand } from "../src/commands/update";
import { applyUpdate, type CommandRunner } from "../src/update/apply";
import {
	CHECK_FAILURE_TTL_MS,
	CHECK_SUCCESS_TTL_MS,
	runRegistryCheck,
	shouldCheckNow,
} from "../src/update/check";
import {
	buildUpdateCommand,
	detectInstallMethod,
	resolveNpmBinary,
} from "../src/update/install-method";
import { prepareTuiLaunch } from "../src/update/launch";
import {
	buildStartupNotices,
	UPDATE_NOTICE_FILE_ENV,
} from "../src/update/notices";
import {
	computeRegistryId,
	fetchLatestVersion,
	normalizeRegistryUrl,
} from "../src/update/registry";
import {
	compareVersions,
	inferChannelFromVersion,
	isNewerVersion,
	isValidVersion,
} from "../src/update/semver";
import { resolveUpdateSettings } from "../src/update/settings";
import {
	readUpdateState,
	resolveInstallApplyLockFile,
	resolveUpdatePaths,
	tryWithSqliteLock,
	writeUpdateState,
} from "../src/update/state";

const makeNpmGlobalFixture = async (
	root: string,
	version: string,
	prefixRel = "prefix",
): Promise<{ prefix: string; packageRoot: string; binPath: string }> => {
	const prefix = path.join(root, prefixRel);
	const packageRoot =
		process.platform === "win32"
			? path.join(prefix, "node_modules", "@codelia", "cli")
			: path.join(prefix, "lib", "node_modules", "@codelia", "cli");
	await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
	await fs.writeFile(
		path.join(packageRoot, "package.json"),
		JSON.stringify({
			name: "@codelia/cli",
			version,
			bin: { codelia: "./dist/index.cjs" },
		}),
	);
	const entry = path.join(packageRoot, "dist", "index.cjs");
	await fs.writeFile(entry, "#!/usr/bin/env node\n", { mode: 0o755 });

	const binPath =
		process.platform === "win32"
			? path.join(prefix, "codelia.cmd")
			: path.join(prefix, "bin", "codelia");
	await fs.mkdir(path.dirname(binPath), { recursive: true });
	if (process.platform === "win32") {
		await fs.writeFile(binPath, "@echo off\r\n");
	} else {
		await fs.symlink(entry, binPath);
	}
	return { prefix, packageRoot, binPath };
};

describe("self-update", () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), "codelia-update-test-")),
		);
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("semver comparison, validation, and channel inference", () => {
		expect(isValidVersion("0.1.87")).toBe(true);
		expect(isValidVersion("1.2.3-beta.10+build.1")).toBe(true);
		expect(isValidVersion("01.2.3")).toBe(false);
		expect(isValidVersion("1.2.3-01")).toBe(false);
		expect(isValidVersion("not-a-version")).toBe(false);

		expect(compareVersions("0.1.88", "0.1.87")).toBe(1);
		expect(compareVersions("0.1.87", "0.1.87")).toBe(0);
		expect(compareVersions("0.1.87-beta.1", "0.1.87")).toBe(-1);
		expect(compareVersions("0.1.87-beta.10", "0.1.87-beta.2")).toBe(1);
		expect(isNewerVersion("0.2.0", "0.1.99")).toBe(true);
		expect(isNewerVersion("0.1.87", "0.1.87")).toBe(false);

		expect(inferChannelFromVersion("0.1.87")).toBe("latest");
		expect(inferChannelFromVersion("0.2.0-beta.1")).toBe("beta");
		expect(inferChannelFromVersion("0.2.0-canary.4")).toBe("canary");
		expect(inferChannelFromVersion("0.2.0-codelia-staging-1")).toBe("latest");
	});

	test("config schema validates update.mode and update.channel", async () => {
		const validFile = path.join(root, "valid-config.json");
		await fs.writeFile(
			validFile,
			JSON.stringify({
				version: 1,
				update: { mode: "notify", channel: "beta" },
			}),
		);
		const parsed = await loadConfig(validFile);
		expect(parsed?.update).toEqual({ mode: "notify", channel: "beta" });

		const badModeFile = path.join(root, "bad-mode.json");
		await fs.writeFile(
			badModeFile,
			JSON.stringify({ version: 1, update: { mode: "always" } }),
		);
		await expect(loadConfig(badModeFile)).rejects.toThrow(/update\.mode/);

		const badChannelFile = path.join(root, "bad-channel.json");
		await fs.writeFile(
			badChannelFile,
			JSON.stringify({
				version: 1,
				update: { channel: "codelia-staging-123" },
			}),
		);
		await expect(loadConfig(badChannelFile)).rejects.toThrow(/update\.channel/);
		expect(resolveTopLevelAction(["update", "--check"])).toBe("update");
	});

	test("registry URL validation and dist-tags fetch", async () => {
		expect(normalizeRegistryUrl("https://registry.npmjs.org/")).toBe(
			"https://registry.npmjs.org",
		);
		expect(() => normalizeRegistryUrl("http://registry.npmjs.org")).toThrow(
			/https/,
		);
		expect(() =>
			normalizeRegistryUrl("https://user:pass@registry.npmjs.org"),
		).toThrow(/credentials/);

		const version = await fetchLatestVersion({
			registryUrl: "https://registry.npmjs.org",
			channel: "latest",
			fetchImpl: async (url) => {
				expect(String(url)).toBe(
					"https://registry.npmjs.org/-/package/%40codelia%2Fcli/dist-tags",
				);
				return Response.json({ latest: "0.2.0", beta: "0.3.0-beta.1" });
			},
		});
		expect(version).toBe("0.2.0");

		await expect(
			fetchLatestVersion({
				registryUrl: "https://registry.npmjs.org",
				channel: "missing",
				fetchImpl: async () => Response.json({ latest: "0.2.0" }),
			}),
		).rejects.toThrow(/dist-tag/);
	});

	test("settings resolve global config, env overrides, and CI/non-interactive opt-out", async () => {
		const configFile = path.join(root, "config.json");
		await fs.writeFile(
			configFile,
			JSON.stringify({
				version: 1,
				update: { mode: "notify", channel: "beta" },
			}),
		);

		expect(
			await resolveUpdateSettings({ configFile, interactive: true, env: {} }),
		).toEqual({ mode: "notify", channel: "beta", warnings: [] });

		expect(
			await resolveUpdateSettings({
				configFile,
				interactive: true,
				env: { CODELIA_AUTO_UPDATE: "off", CODELIA_UPDATE_CHANNEL: "next" },
			}),
		).toEqual({ mode: "off", channel: "next", warnings: [] });

		expect(
			await resolveUpdateSettings({
				configFile,
				interactive: true,
				env: { CI: "true" },
			}),
		).toEqual({ mode: "off", channel: "beta", warnings: [] });

		expect(
			await resolveUpdateSettings({ configFile, interactive: false, env: {} }),
		).toEqual({ mode: "off", channel: "beta", warnings: [] });
	});

	test("install-method detection supports user-owned npm prefixes and excludes external managers", async () => {
		const fakeNpm = path.join(root, "bin", "npm");
		await fs.mkdir(path.dirname(fakeNpm), { recursive: true, mode: 0o755 });
		await fs.writeFile(fakeNpm, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

		// Supports user-owned prefixes (nvm, fnm, Homebrew Node, ~/.npm-global)
		const npmGlobal = await makeNpmGlobalFixture(
			root,
			"0.1.87",
			"homebrew-node",
		);
		const detected = detectInstallMethod({
			packageRoot: npmGlobal.packageRoot,
			resolveNpm: () => fakeNpm,
		});
		expect(detected.kind).toBe("npm-global");
		expect(detected.prefix).toBe(npmGlobal.prefix);
		expect(detected.autoApply).toEqual({ supported: true, npmPath: fakeNpm });
		expect(buildUpdateCommand(detected, { channel: "latest" })).toBe(
			"npm install -g @codelia/cli@latest",
		);

		// Source checkout
		const devDir = path.join(root, "repo", "packages", "cli");
		await fs.mkdir(devDir, { recursive: true });
		expect(detectInstallMethod({ packageRoot: devDir }).kind).toBe(
			"development",
		);

		// External package managers & ephemeral caches
		for (const [rel, expectedKind] of [
			[
				"opt/homebrew/Cellar/codelia/0.1.87/lib/node_modules/@codelia/cli",
				"homebrew",
			],
			["home/.local/share/pnpm/global/5/node_modules/@codelia/cli", "pnpm"],
			["home/.bun/install/global/node_modules/@codelia/cli", "bun"],
			[
				"home/.volta/tools/image/packages/@codelia/cli/node_modules/@codelia/cli",
				"volta",
			],
			["home/.npm/_npx/abc/node_modules/@codelia/cli", "npx"],
			["project/node_modules/@codelia/cli", "local"],
		] as const) {
			const dir = path.join(root, rel);
			await fs.mkdir(dir, { recursive: true });
			const m = detectInstallMethod({
				packageRoot: dir,
				resolveNpm: () => fakeNpm,
			});
			expect(m.kind).toBe(expectedKind);
			expect(m.autoApply.supported).toBe(false);
		}

		// resolveNpmBinary accepts current-user 0755 binary and rejects world-writable binary
		if (process.platform !== "win32") {
			expect(resolveNpmBinary({ PATH: path.dirname(fakeNpm) })).toBe(fakeNpm);
			const unsafeDir = path.join(root, "unsafe-bin");
			await fs.mkdir(unsafeDir, { mode: 0o777 });
			const unsafeNpm = path.join(unsafeDir, "npm");
			await fs.writeFile(unsafeNpm, "#!/bin/sh\nexit 0\n", { mode: 0o777 });
			// Explicitly chmod in case umask masked 0o777
			await fs.chmod(unsafeNpm, 0o777);
			expect(resolveNpmBinary({ PATH: unsafeDir })).not.toBe(unsafeNpm);
		}
	});

	test("check TTL, failure retry window, and scope invalidation", async () => {
		const paths = resolveUpdatePaths(path.join(root, "cache"));
		const regId = computeRegistryId("https://registry.npmjs.org");
		const t0 = Date.parse("2026-11-23T00:00:00Z");

		const ok = await runRegistryCheck({
			paths,
			currentVersion: "0.1.87",
			configuredChannel: null,
			env: {},
			now: () => t0,
			fetchImpl: async () => Response.json({ latest: "0.1.88" }),
		});
		expect(ok).toEqual({
			status: "update_available",
			channel: "latest",
			latest: "0.1.88",
		});

		const state = await readUpdateState(paths.stateFile);
		expect(
			shouldCheckNow(state, {
				now: t0 + CHECK_SUCCESS_TTL_MS - 1000,
				currentVersion: "0.1.87",
				configuredChannel: null,
				registryId: regId,
			}),
		).toBe(false);
		expect(
			shouldCheckNow(state, {
				now: t0 + CHECK_SUCCESS_TTL_MS,
				currentVersion: "0.1.87",
				configuredChannel: null,
				registryId: regId,
			}),
		).toBe(true);
		// Channel or version change invalidates immediately
		expect(
			shouldCheckNow(state, {
				now: t0 + 1000,
				currentVersion: "0.1.87",
				configuredChannel: "beta",
				registryId: regId,
			}),
		).toBe(true);
		expect(
			shouldCheckNow(state, {
				now: t0 + 1000,
				currentVersion: "0.1.88",
				configuredChannel: null,
				registryId: regId,
			}),
		).toBe(true);

		const failed = await runRegistryCheck({
			paths,
			currentVersion: "0.1.87",
			configuredChannel: null,
			env: {},
			now: () => t0,
			fetchImpl: async () => new Response("err", { status: 503 }),
		});
		expect(failed.status).toBe("failed");
		const failState = await readUpdateState(paths.stateFile);
		expect(failState.latest_version).toBe("0.1.88");
		expect(
			shouldCheckNow(failState, {
				now: t0 + CHECK_FAILURE_TTL_MS - 1000,
				currentVersion: "0.1.87",
				configuredChannel: null,
				registryId: regId,
			}),
		).toBe(false);
		expect(
			shouldCheckNow(failState, {
				now: t0 + CHECK_FAILURE_TTL_MS,
				currentVersion: "0.1.87",
				configuredChannel: null,
				registryId: regId,
			}),
		).toBe(true);

		// Switching channel (e.g. preview -> latest) and failing the check MUST discard stale candidate
		await runRegistryCheck({
			paths,
			currentVersion: "0.1.87",
			configuredChannel: "preview",
			env: {},
			now: () => t0,
			fetchImpl: async () => Response.json({ preview: "0.2.0-preview.1" }),
		});
		expect((await readUpdateState(paths.stateFile)).latest_version).toBe(
			"0.2.0-preview.1",
		);
		const switchedFail = await runRegistryCheck({
			paths,
			currentVersion: "0.1.87",
			configuredChannel: "latest",
			env: {},
			now: () => t0 + 1000,
			fetchImpl: async () => new Response("err", { status: 503 }),
		});
		expect(switchedFail.status).toBe("failed");
		const afterSwitch = await readUpdateState(paths.stateFile);
		expect(afterSwitch.channel).toBe("latest");
		expect(afterSwitch.latest_version).toBeUndefined();
		expect(afterSwitch.apply_failure).toBeUndefined();
	});

	test("applyUpdate installs in-place under lock, verifies prefix & version, and defers on lock contention", async () => {
		const paths = resolveUpdatePaths(path.join(root, "cache"));
		const fixture = await makeNpmGlobalFixture(root, "0.1.87");
		const method = detectInstallMethod({
			packageRoot: fixture.packageRoot,
			resolveNpm: () => "/fake/npm",
		});
		expect(method.autoApply.supported).toBe(true);

		await writeUpdateState(paths.stateFile, {
			version: 1,
			latest_version: "0.1.88",
			channel: "latest",
		});

		// Prefix mismatch fails cleanly and marks unmanaged
		const mismatch = await applyUpdate({
			paths,
			method,
			from: "0.1.87",
			to: "0.1.88",
			configuredChannel: null,
			env: {},
			runner: async ({ args }) => {
				expect(args).toEqual(["prefix", "-g"]);
				return {
					code: 0,
					stdout: `${path.join(root, "other-prefix")}\n`,
					stderr: "",
				};
			},
		});
		expect(mismatch).toMatchObject({ status: "failed", unmanaged: true });

		// Lock contention across a DIFFERENT cacheDir still serializes on the install lock
		const otherCachePaths = resolveUpdatePaths(path.join(root, "other-cache"));
		const deferred = await tryWithSqliteLock(
			resolveInstallApplyLockFile(fixture.packageRoot),
			1_000,
			async () =>
				applyUpdate({
					paths: otherCachePaths,
					method,
					from: "0.1.87",
					to: "0.1.88",
					configuredChannel: null,
					env: {},
					runner: async () => {
						throw new Error("should not invoke npm while locked");
					},
				}),
		);
		expect(deferred.acquired).toBe(true);
		if (deferred.acquired) {
			expect(deferred.value).toEqual({ status: "deferred" });
		}

		// Successful in-place update
		const calls: string[][] = [];
		const okRunner: CommandRunner = async ({ args }) => {
			calls.push(args);
			if (args[0] === "prefix") {
				return { code: 0, stdout: `${fixture.prefix}\n`, stderr: "" };
			}
			// Simulate npm replacing package.json with new version
			await fs.writeFile(
				path.join(fixture.packageRoot, "package.json"),
				JSON.stringify({
					name: "@codelia/cli",
					version: "0.1.88",
					bin: { codelia: "./dist/index.cjs" },
				}),
			);
			return { code: 0, stdout: "", stderr: "" };
		};
		const installed = await applyUpdate({
			paths,
			method,
			from: "0.1.87",
			to: "0.1.88",
			configuredChannel: null,
			env: {},
			runner: okRunner,
		});
		expect(installed).toEqual({
			status: "installed",
			from: "0.1.87",
			to: "0.1.88",
		});
		expect(calls[1]).toEqual([
			"install",
			"-g",
			"--prefix",
			fixture.prefix,
			"--no-audit",
			"--no-fund",
			"@codelia/cli@0.1.88",
		]);
		const finalState = await readUpdateState(paths.stateFile);
		expect(finalState.applied?.to).toBe("0.1.88");
		expect(finalState.apply_failure).toBeUndefined();
	});

	test("prepareTuiLaunch defaults to notify, and when opted into auto applies cached update, re-execs, and cleans up notice", async () => {
		const cacheDir = path.join(root, "cache");
		const configFile = path.join(root, "config.json");
		const paths = resolveUpdatePaths(cacheDir);
		const fixture = await makeNpmGlobalFixture(root, "0.1.87");
		const regId = computeRegistryId("https://registry.npmjs.org");
		await writeUpdateState(paths.stateFile, {
			version: 1,
			last_check_at: new Date().toISOString(),
			last_check_ok: true,
			channel: "latest",
			registry_id: regId,
			configured_channel: null,
			latest_version: "0.1.88",
			checked_version: "0.1.87",
		});

		// Default mode is "notify": does NOT run npm install in-place, shows notice instead
		const defaultLaunch = await prepareTuiLaunch({
			args: ["--debug"],
			currentVersion: "0.1.87",
			packageRoot: fixture.packageRoot,
			interactive: true,
			cacheDir,
			configFile,
			env: {},
			resolveNpm: () => "/fake/npm",
			runner: async () => {
				throw new Error("default notify mode must not run npm");
			},
		});
		expect(defaultLaunch.kind).toBe("launch");
		if (defaultLaunch.kind === "launch") {
			const noticePath = defaultLaunch.session.tuiEnv[UPDATE_NOTICE_FILE_ENV];
			expect(noticePath).toBeDefined();
			const payload = JSON.parse(
				await fs.readFile(noticePath as string, "utf8"),
			);
			expect(payload.notices).toEqual([
				"Update available: 0.1.87 -> 0.1.88. Run `codelia update` to install.",
			]);
			defaultLaunch.session.dispose();
		}

		// Opt-in auto mode applies cached update and re-execs
		const reexecCalls: Array<{
			entry: string;
			args: string[];
			env: NodeJS.ProcessEnv;
		}> = [];
		const first = await prepareTuiLaunch({
			args: ["--debug"],
			currentVersion: "0.1.87",
			packageRoot: fixture.packageRoot,
			interactive: true,
			cacheDir,
			configFile,
			env: { CODELIA_AUTO_UPDATE: "auto" },
			resolveNpm: () => "/fake/npm",
			runner: async ({ args }) => {
				if (args[0] === "prefix") {
					return { code: 0, stdout: `${fixture.prefix}\n`, stderr: "" };
				}
				await fs.writeFile(
					path.join(fixture.packageRoot, "package.json"),
					JSON.stringify({
						name: "@codelia/cli",
						version: "0.1.88",
						bin: { codelia: "./dist/index.cjs" },
					}),
				);
				return { code: 0, stdout: "", stderr: "" };
			},
			reexec: async (opts) => {
				reexecCalls.push(opts);
				return 0;
			},
		});
		expect(first).toEqual({ kind: "exit", exitCode: 0 });
		expect(reexecCalls).toHaveLength(1);
		expect(reexecCalls[0]?.args).toEqual(["--debug"]);
		expect(reexecCalls[0]?.env.CODELIA_UPDATE_REEXEC).toBe("0.1.87");

		// Re-exec'd launch emits updated notice file and cleans it up on dispose
		const second = await prepareTuiLaunch({
			args: ["--debug"],
			currentVersion: "0.1.88",
			packageRoot: fixture.packageRoot,
			interactive: true,
			cacheDir,
			configFile,
			env: { CODELIA_UPDATE_REEXEC: "0.1.87" },
			resolveNpm: () => "/fake/npm",
		});
		expect(second.kind).toBe("launch");
		if (second.kind === "launch") {
			const noticePath = second.session.tuiEnv[UPDATE_NOTICE_FILE_ENV];
			expect(noticePath).toBeDefined();
			const payload = JSON.parse(
				await fs.readFile(noticePath as string, "utf8"),
			);
			expect(payload.notices).toEqual(["Updated Codelia 0.1.87 -> 0.1.88."]);
			second.session.dispose();
			await expect(fs.access(noticePath as string)).rejects.toThrow();
		}
	});

	test("codelia update --check and notify notices work end-to-end", async () => {
		const cacheDir = path.join(root, "cache");
		const configFile = path.join(root, "config.json");
		const fixture = await makeNpmGlobalFixture(root, "0.1.87");
		const out: string[] = [];
		const err: string[] = [];

		const code = await runUpdateCommand(["--check"], {
			currentVersion: "0.1.87",
			packageRoot: fixture.packageRoot,
			cacheDir,
			configFile,
			env: {},
			resolveNpm: () => "/fake/npm",
			fetchImpl: async () => Response.json({ latest: "0.1.90" }),
			out: (l) => out.push(l),
			err: (l) => err.push(l),
		});
		expect(code).toBe(0);
		expect(err).toEqual([]);
		expect(out).toEqual([
			"Current: 0.1.87. Latest (latest): 0.1.90.",
			"Update with: codelia update",
		]);

		const state = await readUpdateState(resolveUpdatePaths(cacheDir).stateFile);
		const method = detectInstallMethod({
			packageRoot: fixture.packageRoot,
			resolveNpm: () => "/fake/npm",
		});
		expect(
			buildStartupNotices(state, {
				currentVersion: "0.1.87",
				mode: "notify",
				method,
			}),
		).toEqual([
			"Update available: 0.1.87 -> 0.1.90. Run `codelia update` to install.",
		]);
	});
});
