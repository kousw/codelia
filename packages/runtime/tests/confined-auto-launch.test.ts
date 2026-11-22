import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import type { ToolContext } from "@codelia/core";
import type { SandboxMode } from "@codelia/shared-types";
import { resolveStoragePaths, TaskRegistryStore } from "@codelia/storage";
import type { Confirmation } from "../src/permissions/dispatch";
import { runtimeLocalAutoReview } from "../src/permissions/local-reviewer";
import { authorizeRuntimeShell } from "../src/permissions/runtime-approval";
import type { ShellApprovalInput } from "../src/permissions/shell-approval";
import {
	MacSeatbeltBackend,
	type ProtectedShellBackend,
	type ShellProtection,
} from "../src/permissions/shell-backend";
import { RuntimeState } from "../src/runtime-state";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { TaskManager } from "../src/tasks";
import { createShellTool } from "../src/tools/shell";
import { fixtureShellBackend } from "./fixtures/approval";

const context: ToolContext = {
	deps: {},
	resolve: async (key) => key.create(),
};

const withShell = async (
	backend: ProtectedShellBackend,
	run: (fixture: Awaited<ReturnType<typeof setupShell>>) => Promise<void>,
) => {
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), "codelia-in-sandbox-")),
	);
	const layout = process.env.CODELIA_LAYOUT;
	const configHome = process.env.XDG_CONFIG_HOME;
	const fetcher = globalThis.fetch;
	const tasks = new TaskManager({
		registry: new TaskRegistryStore(path.join(root, "tasks")),
	});
	try {
		process.env.CODELIA_LAYOUT = "xdg";
		process.env.XDG_CONFIG_HOME = path.join(root, "config");
		let requests = 0;
		globalThis.fetch = Object.assign(
			async () => {
				requests++;
				throw new Error(
					"Unexpected provider call in the confined launch fixture",
				);
			},
			{ preconnect: fetcher.preconnect },
		);
		await run(await setupShell(root, backend, tasks, () => requests));
	} finally {
		globalThis.fetch = fetcher;
		for (const [key, value] of Object.entries({
			CODELIA_LAYOUT: layout,
			XDG_CONFIG_HOME: configHome,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await tasks.shutdown();
		await rm(root, { recursive: true, force: true });
	}
};

const setupShell = async (
	root: string,
	backend: ProtectedShellBackend,
	tasks: TaskManager,
	requests: () => number,
) => {
	const workspace = path.join(root, "workspace");
	const external = path.join(root, "external");
	const bin = path.join(root, "bin");
	const config = resolveStoragePaths().configDir;
	for (const directory of [workspace, external, bin, config])
		await mkdir(directory, { mode: 0o700, recursive: true });
	for (const command of ["cargo", "rg"])
		await writeFile(
			path.join(bin, command),
			`#!/bin/sh\nprintf '%s\\n' '${command}' "$@"\n`,
			{ mode: 0o700 },
		);
	const prompts: Confirmation[] = [];
	const launches: ShellProtection[] = [];
	const state = new RuntimeState();
	const select = (enabled: boolean) => {
		const selection = runtimeLocalAutoReview(state).configuration(workspace);
		if (enabled) selection.enable();
		else selection.disable();
	};
	select(true);
	let supported = true;
	state.setRuntimeEnvironment({
		environment: { preset: "tui-local" },
		adapters: {
			shellPath: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
			approvalShellAuthority: {
				investigation: true,
				workspaceWrite: "granted",
				stdinPipe: "forbid",
				extraWriteCeiling: [external],
			},
			shellProtectionBackend: {
				supportsReadOnlyPaths: backend.supportsReadOnlyPaths,
				supportsHomeDotProtection: backend.supportsHomeDotProtection,
				supportsCommandBinding: backend.supportsCommandBinding,
				supports: (protection) => supported && backend.supports(protection),
				supportsInvocation: backend.supportsInvocation?.bind(backend),
				launch(invocation, protection) {
					launches.push(protection);
					return backend.launch(invocation, protection);
				},
			},
			approvalService: {
				confirm: async (request) => {
					prompts.push(request);
					return { requestId: request.requestId, choice: "deny_continue" };
				},
			},
		},
	});
	state.runtimeSandboxRoot = workspace;
	state.runtimeWorkingDir = workspace;
	state.sessionId = state.nextSessionId();
	state.beginRun("run", null, "Run the local test.");
	const authorize = authorizeRuntimeShell(state);
	const mode = (value: SandboxMode) => {
		state.sandboxMode = { value, source: "cli" };
	};
	const shell = async (command: string) => {
		const sandbox = await SandboxContext.create(workspace, {
			sandboxMode: state.sandboxMode.value,
		});
		const tool = createShellTool(createSandboxKey(sandbox), {
			authorizeShell: authorize,
			taskManager: tasks,
			outputCacheStore: null,
		});
		return tool.executeRaw(JSON.stringify({ command }), context);
	};
	return {
		authorize,
		external,
		launches,
		mode,
		prompts,
		requests,
		select,
		shell,
		state,
		workspace,
		setSupported: (value: boolean) => {
			supported = value;
		},
	};
};

const expectOrdinaryLaunches = async (
	fixture: Awaited<ReturnType<typeof setupShell>>,
) => {
	const { authorize, launches, mode, prompts, requests, shell, workspace } =
		fixture;
	for (const sandbox of ["readonly", "workspace-write"] as const) {
		mode(sandbox);
		const before = launches.length;
		expect(await shell("cargo test")).toMatchObject({
			value: { exit_code: 0, stdout: "cargo\ntest" },
		});
		expect(launches).toHaveLength(before + 1);
		await authorize(
			{
				cwd: workspace,
				origin: "parent_agent",
				argv: ["rg", "-e", "TODO", "src"],
			},
			async (admit) => {
				const child = admit();
				const stdout = text(child.stdout);
				child.stderr.resume();
				expect((await once(child, "close"))[0]).toBe(0);
				expect(await stdout).toBe("rg\n-e\nTODO\nsrc\n");
				expect(() => admit()).toThrow("approval_already_consumed");
			},
		);
		expect(launches).toHaveLength(before + 2);
		expect(
			launches
				.slice(before)
				.map(({ profile, writeRoots }) => [profile, writeRoots]),
		).toEqual(
			Array.from({ length: 2 }, () =>
				sandbox === "readonly"
					? ["investigation", []]
					: ["development", [workspace]],
			),
		);
	}
	expect(prompts).toHaveLength(0);
	expect(requests()).toBe(0);
};

test.skipIf(typeof process.geteuid !== "function")(
	"selected Auto approve launches unlisted source and argv once without a reviewer or prompt",
	() => withShell(fixtureShellBackend, expectOrdinaryLaunches),
);

test.skipIf(typeof process.geteuid !== "function")(
	"confined launch settings persist for the chosen workspace only",
	() =>
		withShell(
			fixtureShellBackend,
			async ({ external, select, state, workspace }) => {
				const status = runtimeLocalAutoReview(new RuntimeState());
				expect(status.status(workspace)).toMatchObject({
					state: "off",
					confined_launch_enabled: true,
				});
				expect(status.status(external).confined_launch_enabled).toBe(false);
				runtimeLocalAutoReview(state).configuration(external).enable();
				select(false);
				expect(status.status(workspace).confined_launch_enabled).toBe(false);
				expect(status.status(external).confined_launch_enabled).toBe(true);
			},
		),
);

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
	"bound find inspection is checked against deny rules without invoking a reviewer",
	() =>
		withShell(
			fixtureShellBackend,
			async ({ authorize, launches, prompts, requests, workspace }) => {
				const input = {
					cwd: workspace,
					origin: "parent_agent",
					source: "find . -name fixture",
				} as const;
				await authorize(
					{ ...input, deny: [{ tool: "shell", command: "git push" }] },
					async (admit) => {
						const child = admit();
						child.stdout.resume();
						child.stderr.resume();
						expect((await once(child, "close"))[0]).toBe(0);
					},
				);
				await expect(
					authorize(
						{
							...input,
							deny: [
								{
									tool: "shell",
									command: `${await realpath("/usr/bin/find")} .`,
								},
							],
						},
						() => {
							throw new Error("Unexpected denied launch");
						},
					),
				).rejects.toThrow("legacy_deny_rule");
				expect(launches).toHaveLength(1);
				expect(prompts).toHaveLength(0);
				expect(requests()).toBe(0);
			},
		),
);

test.skipIf(typeof process.geteuid !== "function")(
	"confined auto launch preserves denies, host limits, manual routes and expiration",
	() =>
		withShell(fixtureShellBackend, async (fixture) => {
			const {
				authorize,
				external,
				launches,
				mode,
				prompts,
				requests,
				select,
				setSupported,
				state,
				workspace,
			} = fixture;
			const parent = {
				cwd: workspace,
				origin: "parent_agent",
				source: "cargo test",
			} as const;
			const reject = (input: ShellApprovalInput, reason: string) =>
				expect(
					authorize(input, () => {
						throw new Error("Unexpected shell admission");
					}),
				).rejects.toThrow(reason);
			await reject(
				{ ...parent, deny: [{ tool: "shell", command: "cargo test" }] },
				"legacy_deny_rule",
			);
			await reject(
				{
					cwd: workspace,
					origin: "parent_agent",
					argv: ["rg", "-e", "TODO", "src"],
					deny: [{ tool: "shell", command: "rg -e TODO" }],
				},
				"legacy_deny_rule",
			);
			await reject(
				{
					...parent,
					source: 'printf "%s" "$TERM"',
					deny: [{ tool: "shell", command: "cargo test" }],
				},
				"deny_rule_unverifiable",
			);
			await reject({ ...parent, cwd: external }, "outside_authority_ceiling");
			await reject({ ...parent, owner: "other-session" }, "owner_mismatch");
			await reject({ ...parent, stdin: "pipe" }, "outside_authority_ceiling");
			setSupported(false);
			await reject(parent, "sandbox_unavailable");
			setSupported(true);
			expect(prompts).toHaveLength(0);

			await reject(
				{ ...parent, additionalWriteRoots: [external] },
				"user_denied",
			);
			expect(prompts.at(-1)?.route).toMatchObject({
				kind: "human",
				reason: "additional_resources",
			});
			await reject(
				{
					...parent,
					origin: "child_agent",
					owner: state.sessionId ?? undefined,
					childSandboxCeiling: "readonly",
				},
				"user_denied",
			);
			expect(prompts.at(-1)).toMatchObject({
				origin: "child_agent",
				route: { profile: "investigation" },
			});
			mode("full-access");
			await reject(parent, "user_denied");
			expect(prompts.at(-1)?.route.profile).toBe("full-access");
			mode("workspace-write");
			await expect(
				authorize(parent, async (admit) => {
					select(false);
					await Promise.resolve();
					admit();
				}),
			).rejects.toThrow("approval_expired");
			await reject(parent, "user_denied");
			expect(prompts.at(-1)?.route).toMatchObject({
				kind: "human",
				reason: "no_launch_rule",
			});
			expect(prompts).toHaveLength(4);
			expect(launches).toHaveLength(0);
			expect(requests()).toBe(0);
		}),
);

for (const backend of ["seatbelt", "mxc"] as const) {
	const enabled =
		backend === "mxc"
			? process.arch === "arm64" &&
				process.env.CODELIA_APPROVAL_MXC_LIVE === "1"
			: process.env.CODELIA_APPROVAL_MAC_LIVE === "1";
	test.skipIf(process.platform !== "darwin" || !enabled)(
		`confined Auto approve executes normal commands under native ${backend}`,
		() => withShell(new MacSeatbeltBackend(backend), expectOrdinaryLaunches),
	);
}

test.skipIf(typeof process.geteuid !== "function")(
	"home workspace persists Auto approve with home warning, isolates child repos, blocks agent writes and rejects symlinks",
	async () => {
		const home = await realpath(
			await mkdtemp(path.join(tmpdir(), "codelia-home-auto-approve-")),
		);
		const nestedRepo = path.join(home, "work", "repo");
		const redirectTarget = path.join(home, "elsewhere");
		try {
			await mkdir(nestedRepo, { recursive: true, mode: 0o700 });
			await mkdir(redirectTarget, { recursive: true, mode: 0o700 });
			const check = Bun.spawnSync({
				cwd: path.resolve(import.meta.dir, ".."),
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					USERPROFILE: home,
					CODELIA_LAYOUT: "home",
					CODELIA_SANDBOX_ROOT: home,
				},
				cmd: [
					process.execPath,
					"-e",
					`import { promises as fs } from "node:fs";
					import path from "node:path";
					import { confinedWorkspaceConfigName, runtimeLocalAutoReview } from "./src/permissions/local-reviewer";
					import { confinedAutoLaunchDirectoryName } from "./src/permissions/workspace-config-paths";
					import { createRuntimeHandlers } from "./src/rpc/handlers";
					import { RuntimeState } from "./src/runtime-state";
					import { SandboxContext } from "./src/sandbox/context";
					const home = process.argv[1];
					const nestedRepo = process.argv[2];
					const redirectTarget = process.argv[3];

					const state = new RuntimeState();
					state.runtimeWorkingDir = home;
					state.runtimeSandboxRoot = home;
					state.setUiCapabilities({ supports_pick: true });
					const messages = [];
					const pickPrompts = [];
					const origWrite = process.stdout.write.bind(process.stdout);
					const handlers = createRuntimeHandlers({
						state,
						log: () => {},
						getAgent: async () => { throw new Error("unexpected"); },
					});
					process.stdout.write = (chunk) => {
						for (const line of String(chunk).trim().split("\\n")) {
							if (!line) continue;
							const msg = JSON.parse(line);
							messages.push(msg);
							if (msg.method === "ui.pick.request") {
								pickPrompts.push(msg.params);
								queueMicrotask(() => {
									handlers.processMessage({
										jsonrpc: "2.0",
										id: msg.id,
										result: { ids: ["enable"] },
									});
								});
							}
						}
						return true;
					};
					const call = async (method, params) => {
						const id = "rpc-" + messages.length + "-" + method;
						handlers.processMessage({ jsonrpc: "2.0", id, method, params });
						const deadline = Date.now() + 3000;
						while (Date.now() < deadline) {
							const found = messages.find((m) => m.id === id && !m.method);
							if (found) return found;
							await Bun.sleep(5);
						}
						throw new Error("timeout: " + method);
					};
					try {
						const enabled = await call("auto_review.configure", {});
						if (enabled.error) throw new Error("enable failed: " + JSON.stringify(enabled.error));
						if (enabled.result?.confined_launch_enabled !== true)
							throw new Error("expected confined_launch_enabled true");
						const promptMessage = pickPrompts[0]?.message ?? "";
						if (!promptMessage.includes("covers your entire home directory"))
							throw new Error("expected home warning in picker: " + promptMessage);

						// Reload in a fresh RuntimeState: home stays enabled, nested repo stays off.
						const reopened = runtimeLocalAutoReview(new RuntimeState());
						if (reopened.status(home).confined_launch_enabled !== true)
							throw new Error("expected persisted home setting");
						if (reopened.status(nestedRepo).confined_launch_enabled !== false)
							throw new Error("home setting must not inherit into nested repo");

						// Built-in SandboxContext still blocks agent writes to ~/.codelia settings.
						const sandbox = await SandboxContext.create(home, {
							protectResources: true,
							sandboxMode: "workspace-write",
						});
						const launchFile = path.join(
							home,
							".codelia",
							confinedAutoLaunchDirectoryName,
							confinedWorkspaceConfigName(home),
						);
						for (const target of [launchFile, path.join(home, ".codelia", "auto-review.json")]) {
							let blocked = false;
							try {
								sandbox.resolvePath(target, "write");
							} catch (error) {
								blocked = String(error).includes("Path is read-only");
							}
							if (!blocked) throw new Error("expected read-only protection for " + target);
						}

						// Disable works in home workspace.
						const disabled = await call("auto_review.configure", { action: "off" });
						if (disabled.error || disabled.result?.confined_launch_enabled !== false)
							throw new Error("disable failed: " + JSON.stringify(disabled));

						// Corrupted workspace launch file is reported even in a fresh RuntimeState
						// while auto-review.json itself is healthy or absent.
						await fs.writeFile(launchFile, "{ broken json", { mode: 0o600 });
						const corruptedStatus = runtimeLocalAutoReview(new RuntimeState()).status(home);
						if (
							corruptedStatus.confined_launch_enabled !== false ||
							corruptedStatus.confined_launch_issue !== "confined_launch_config_unavailable"
						)
							throw new Error(
								"expected fresh RuntimeState to report confined_launch_config_unavailable: " +
									JSON.stringify(corruptedStatus),
							);
						const corruptedStartup = runtimeLocalAutoReview(new RuntimeState()).startupStatus(home);
						if (corruptedStartup.auto_review_confined_launch_issue !== "confined_launch_config_unavailable")
							throw new Error(
								"expected startupStatus to report confined_launch_config_unavailable: " +
									JSON.stringify(corruptedStartup),
							);
						await fs.rm(launchFile, { force: true });

						// Non-default XDG_CONFIG_HOME pointing inside ~ (e.g. a checkout) must be rejected.
						process.env.CODELIA_LAYOUT = "xdg";
						process.env.XDG_CONFIG_HOME = path.join(nestedRepo, ".config");
						const nonDefaultXdgErr = await call("auto_review.configure", {});
						if (!nonDefaultXdgErr.error?.message?.includes("inside this workspace"))
							throw new Error(
								"expected non-default XDG inside ~ rejection: " +
									JSON.stringify(nonDefaultXdgErr),
							);
						process.env.CODELIA_LAYOUT = "home";
						delete process.env.XDG_CONFIG_HOME;

						// Symlinked confined-auto-launch directory reports symbolic link reason.
						await fs.rm(path.join(home, ".codelia", confinedAutoLaunchDirectoryName), {
							recursive: true,
							force: true,
						});
						await fs.symlink(
							redirectTarget,
							path.join(home, ".codelia", confinedAutoLaunchDirectoryName),
						);
						const symlinkErr = await call("auto_review.configure", {});
						if (!symlinkErr.error?.message?.includes("symbolic link"))
							throw new Error("expected symbolic link error: " + JSON.stringify(symlinkErr));

						// Symlinked ~/.codelia itself reports symbolic link reason instead of generic inside-workspace hint.
						await fs.rm(path.join(home, ".codelia"), { recursive: true, force: true });
						await fs.symlink(redirectTarget, path.join(home, ".codelia"));
						const rootSymlinkErr = await call("auto_review.configure", {});
						if (!rootSymlinkErr.error?.message?.includes("symbolic link"))
							throw new Error("expected symbolic link error: " + JSON.stringify(rootSymlinkErr));

						// Non-home workspace outside configDir keeps working even if an outer
						// parent directory (e.g. ~/.config under umask 002) is 0775.
						const xdgParent = path.join(home, "xdg-0775");
						await fs.mkdir(xdgParent, { recursive: true });
						await fs.chmod(xdgParent, 0o775);
						process.env.CODELIA_LAYOUT = "xdg";
						process.env.XDG_CONFIG_HOME = xdgParent;
						runtimeLocalAutoReview(new RuntimeState()).configuration(nestedRepo).enable();
						if (
							runtimeLocalAutoReview(new RuntimeState()).status(nestedRepo)
								.confined_launch_enabled !== true
						)
							throw new Error("expected non-home workspace under 0775 XDG parent to succeed");
					} finally {
						process.stdout.write = origWrite;
					}`,
					home,
					nestedRepo,
					redirectTarget,
				],
			});
			expect(check.stderr.toString()).toBe("");
			expect(check.exitCode).toBe(0);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	},
	10_000,
);
