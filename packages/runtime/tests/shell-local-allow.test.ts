import { expect, test } from "bun:test";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PermissionRule } from "@codelia/config";
import { ApprovalDispatcher } from "../src/permissions/dispatch";
import { LaunchRuleStore } from "../src/permissions/launch-rules";
import { authorizeRuntimeShell } from "../src/permissions/runtime-approval";
import { matchesShellAllow } from "../src/permissions/shell-allow";
import {
	createShellAuthorizer,
	type ShellApprovalInput,
} from "../src/permissions/shell-approval";
import type { ShellChild } from "../src/permissions/shell-backend";
import { RuntimeState } from "../src/runtime-state";
import {
	fixtureShellAuthority,
	fixtureShellBackend,
} from "./fixtures/approval";

test.skipIf(process.platform === "win32")(
	"the local runtime loads and revokes a user-written shell permission",
	async () => {
		const base = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-policy-runtime-")),
		);
		const root = path.join(base, "workspace");
		const config = path.join(base, "user.json");
		const env = {
			CODELIA_CONFIG_PATH: config,
			CODELIA_LAYOUT: "xdg",
			XDG_CONFIG_HOME: path.join(base, "config"),
			XDG_STATE_HOME: path.join(base, "state"),
			XDG_CACHE_HOME: path.join(base, "cache"),
		};
		const before = Object.keys(env).map(
			(key) => [key, process.env[key]] as const,
		);
		try {
			Object.assign(process.env, env);
			mkdirSync(root);
			const bin = path.join(base, "bin");
			mkdirSync(bin);
			const executable = path.join(bin, "cargo");
			const sibling = path.join(bin, "cargo-copy");
			const outsideAlias = path.join(root, "cargo-copy");
			writeFileSync(executable, "fixture", { mode: 0o700 });
			linkSync(executable, sibling);
			const configure = (allow: PermissionRule[]) =>
				writeFileSync(
					config,
					JSON.stringify({ version: 1, permissions: { allow } }),
				);
			configure([{ tool: "shell", command: "cargo test" }]);
			let launches = 0;
			let prompts = 0;
			const state = new RuntimeState();
			state.runtimeWorkingDir = state.runtimeSandboxRoot = root;
			state.setRuntimeEnvironment({
				environment: { preset: "tui-local" },
				adapters: {
					shellPath: bin,
					shellProtectionBackend: {
						...fixtureShellBackend,
						launch: () => {
							launches++;
							return {} as ShellChild;
						},
					},
					approvalService: {
						confirm: async ({ requestId }) => {
							prompts++;
							return { requestId, choice: "allow_once" };
						},
					},
				},
			});
			const authorize = authorizeRuntimeShell(state);
			const request = {
				cwd: root,
				origin: "parent_agent" as const,
				source: "cargo test --release",
			};
			await authorize(request, (admit) => admit());
			const directRequest = {
				cwd: root,
				origin: "parent_agent" as const,
				argv: ["cargo", "test", "--quiet"],
			};
			await authorize(directRequest, (admit) => admit());
			expect(prompts).toBe(0);
			expect(launches).toBe(2);
			await expect(
				authorize(request, (admit) => {
					linkSync(executable, outsideAlias);
					return admit();
				}),
			).rejects.toThrow("approval_expired");
			expect(prompts).toBe(0);
			expect(launches).toBe(2);
			unlinkSync(sibling);
			symlinkSync(executable, sibling);
			await authorize(directRequest, (admit) => admit());
			expect(prompts).toBe(1);
			expect(launches).toBe(3);
			unlinkSync(outsideAlias);
			unlinkSync(sibling);
			linkSync(executable, sibling);
			await expect(
				authorize(request, (admit) => {
					chmodSync(base, 0o770);
					return admit();
				}),
			).rejects.toThrow("approval_expired");
			chmodSync(base, 0o700);
			await expect(
				authorize(request, (admit) => {
					configure([]);
					return admit();
				}),
			).rejects.toThrow("approval_expired");
			expect(launches).toBe(3);
			await authorize(request, (admit) => admit());
			expect(prompts).toBe(2);
			expect(launches).toBe(4);
		} finally {
			for (const [key, value] of before) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test("handwritten rules retain word prefixes and legacy command globs on bound invocations", () => {
	const match = (rule: Omit<PermissionRule, "tool">, ...words: string[]) =>
		matchesShellAllow({ tool: "shell", ...rule }, words);
	expect(match({ command: "cargo test" }, "cargo", "test")).toBe(true);
	expect(match({ command: "cargo test" }, "cargo", "test", "--release")).toBe(
		true,
	);
	expect(match({ command: "cargo test" }, "cargo", "testimony")).toBe(false);
	for (const rule of [
		{ command_glob: "cargo test *" },
		{ command: "cargo test *" },
	]) {
		expect(match(rule, "cargo", "test")).toBe(true);
		expect(match(rule, "cargo", "test", "--release")).toBe(true);
		expect(match(rule, "cargo", "testcase")).toBe(false);
		expect(match(rule, "cargo", "fmt")).toBe(false);
	}
	expect(match({ command: "tool 'two words'" }, "tool", "two words")).toBe(
		true,
	);
	expect(match({ command: "tool 'two words'" }, "tool", "two", "words")).toBe(
		false,
	);
	expect(
		match({ command: "tool test", command_glob: "tool *" }, "tool", "build"),
	).toBe(false);
	expect(match({}, "cargo", "test")).toBe(true);
	expect(match({ command_glob: "*" }, "cargo", "test")).toBe(true);
	expect(
		match({ command_glob: "cargo t?st*" }, "cargo", "test", "--release"),
	).toBe(true);
	expect(
		match({ command_glob: "cargo * --release" }, "cargo", "test", "--release"),
	).toBe(true);
	expect(
		match({ command_glob: "cargo test *" }, "cargo", "test this", "extra"),
	).toBe(false);
	expect(match({ command_glob: "cargo ??" }, "cargo", "test")).toBe(false);
	expect(
		matchesShellAllow(
			{ tool: "shell", command_glob: "cargo t?st*" },
			["cargo", "test"],
			"cargo   test",
		),
	).toBe(true);
	expect(
		matchesShellAllow(
			{ tool: "shell", command_glob: "tool 'two words'" },
			["tool", "two  words"],
			"tool 'two  words'",
		),
	).toBe(false);
	expect(
		matchesShellAllow({ tool: "bash", command: "cargo test" }, [
			"cargo",
			"test",
			"--release",
		]),
	).toBe(true);
	for (const rule of [
		{ command: "  " },
		{ command_glob: "cargo * --release" },
		{ command: "cargo test; *" },
		{ command: "cargo test && true" },
		{ command: "cargo test *", skill_name: "foo" },
	])
		expect(match(rule, "cargo", "test")).toBe(false);
});

test.skipIf(process.platform === "win32")(
	"local allow binds one confined invocation, honors denials and expires on revocation",
	async () => {
		const base = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-local-shell-")),
		);
		try {
			const root = path.join(base, "workspace");
			const bin = path.join(base, "bin");
			mkdirSync(root);
			mkdirSync(bin);
			writeFileSync(path.join(bin, "cargo"), "fixture", { mode: 0o700 });
			const prompts: string[] = [];
			let launches = 0;
			let allow: PermissionRule[] = [
				{ tool: "shell", command: "cargo test" },
				{ tool: "shell", command: "echo" },
				{ tool: "shell", command: "printf" },
			];
			const authorize = (
				options: Partial<Parameters<typeof createShellAuthorizer>[0]> = {},
			) =>
				createShellAuthorizer({
					root,
					shellPath: bin,
					backend: {
						...fixtureShellBackend,
						launch: () => {
							launches++;
							return {} as ShellChild;
						},
					},
					launchRules: new LaunchRuleStore(path.join(base, "rules")),
					authority: fixtureShellAuthority,
					policy: () => ({ allow }),
					dispatcher: new ApprovalDispatcher({
						confirmation: {
							confirm: async (request) => {
								prompts.push(request.preview);
								return { requestId: request.requestId, choice: "allow_once" };
							},
						},
					}),
					...options,
				});
			const input = {
				origin: "parent_agent" as const,
				cwd: root,
				source: "cargo test --release",
			};
			const run = (request: ShellApprovalInput) =>
				authorize()(request, (admit) => admit());
			await run(input);
			await run({ ...input, source: "cargo test test_release" });
			await run({ ...input, source: "echo -n hello" });
			await run({ ...input, source: "printf '%s' hello" });
			await run({
				cwd: root,
				origin: "parent_agent",
				argv: ["cargo", "test", "test_remove"],
			});
			expect(prompts).toHaveLength(0);
			await expect(
				run({
					...input,
					source: "cargo test test_remove",
					deny: [{ tool: "shell", command: "cargo test" }],
				}),
			).rejects.toThrow("legacy_deny_rule");
			for (const source of [
				"cargo test && cargo build",
				"cargo test | cargo test",
				"cargo test > out",
				"cargo test; ",
				"cargo test *",
				"cargo test --exec",
				"cargo test --config override.toml",
				"cargo test --config=override.toml",
				"printf -v out '%s' hello",
				"cargo build",
			])
				await run({ ...input, source });
			await run({ ...input, origin: "child_agent" });
			await run({ ...input, stdin: "pipe" });
			await authorize({ sandboxMode: "full-access" })(input, (admit) =>
				admit(),
			);
			expect(prompts).toHaveLength(13);
			const previousAllow = allow;
			allow = [{ tool: "shell", command: "cargo" }];
			for (const source of [
				"cargo --config override.toml test",
				"cargo +stable --config=override.toml test",
				"cargo +stable test --config override.toml",
				"cargo --config=override.toml check",
			]) {
				const before = prompts.length;
				await run({ ...input, source });
				expect(prompts).toHaveLength(before + 1);
			}
			const beforeForwardedOption = prompts.length;
			await run({
				...input,
				source: "cargo +stable test -- --config=override.toml",
			});
			expect(prompts).toHaveLength(beforeForwardedOption);
			allow = previousAllow;
			await expect(
				run({ ...input, additionalWriteRoots: [bin] }),
			).rejects.toThrow("outside_authority_ceiling");
			const before = launches;
			await expect(
				authorize()(input, (admit) => {
					allow = [];
					return admit();
				}),
			).rejects.toThrow("approval_expired");
			expect(launches).toBe(before);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);
