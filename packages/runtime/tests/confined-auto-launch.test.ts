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
