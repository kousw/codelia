import { expect, test } from "bun:test";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRuntimeEnvironment } from "../src/environment";
import { ApprovalDispatcher } from "../src/permissions/dispatch";
import { LaunchRuleStore } from "../src/permissions/launch-rules";
import { authorizeRuntimeShell } from "../src/permissions/runtime-approval";
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import type {
	ProtectedShellBackend,
	ShellChild,
} from "../src/permissions/shell-backend";
import {
	resolveShellExecutable,
	shellBinPaths,
	shellPathForLaunch,
} from "../src/permissions/shell-path";
import { RuntimeState } from "../src/runtime-state";
import {
	approveFixture,
	fixtureShellAuthority,
	fixtureShellBackend,
} from "./fixtures/approval";

const executableFixture = (directory: string, name: string, result: string) => {
	const executable = path.join(directory, name);
	writeFileSync(executable, `#!/bin/sh\nprintf '%s' '${result}'\n`, {
		mode: 0o755,
	});
	return executable;
};

const capture = async (child: ShellChild): Promise<string> => {
	const [[code], stdout, stderr] = await Promise.all([
		once(child, "close"),
		Array.fromAsync(child.stdout),
		Array.fromAsync(child.stderr),
	]);
	if (code !== 0)
		throw new Error(
			`Fixture exit ${code}: ${Buffer.concat(stderr).toString()}`,
		);
	return Buffer.concat(stdout).toString();
};

test("full-access admission passes explicit Rust homes and inherits the runtime environment", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-full-access-rust-")),
	);
	const cargo = path.join(root, "cargo home");
	const rustup = path.join(root, "rustup home");
	const keys = ["CARGO_HOME", "RUSTUP_HOME", "CODELIA_TEST_EXTRA_ENV"] as const;
	const previous = keys.map((key) => [key, process.env[key]] as const);
	try {
		mkdirSync(cargo);
		mkdirSync(rustup);
		process.env.CARGO_HOME = cargo;
		process.env.RUSTUP_HOME = rustup;
		process.env.CODELIA_TEST_EXTRA_ENV = "fixture value";
		const state = new RuntimeState();
		state.runtimeWorkingDir = state.runtimeSandboxRoot = root;
		state.setRuntimeEnvironment({
			adapters: { approvalService: approveFixture },
		});
		state.sandboxMode = { value: "full-access", source: "fallback" };
		const run = () =>
			authorizeRuntimeShell(state)(
				{
					cwd: root,
					origin: "parent_agent",
					argv: [
						process.execPath,
						"-e",
						"console.log(JSON.stringify(process.argv.slice(1).map(key => process.env[key] ?? null)))",
						...keys,
					],
				},
				(admit) => capture(admit()),
			);
		expect(JSON.parse(await run())).toEqual([cargo, rustup, "fixture value"]);
		delete process.env.CARGO_HOME;
		delete process.env.RUSTUP_HOME;
		expect(JSON.parse(await run())).toEqual([null, null, "fixture value"]);
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("command PATH preserves native separators, spelling, empty entries and SDK validation", () => {
	const pathValue = ["absolute directory", "", ".", "relative"].join(
		path.delimiter,
	);
	expect(shellPathForLaunch(shellBinPaths(pathValue))).toBe(pathValue);
	expect(shellBinPaths("")).toEqual([""]);
	expect(shellPathForLaunch(shellBinPaths())).toBe(process.env.PATH ?? "");
	expect(
		resolveRuntimeEnvironment({ adapters: { shellPath: "" } }).adapters
			.shellPath,
	).toBe("");
	expect(() =>
		resolveRuntimeEnvironment({ adapters: { shellPath: "invalid\0value" } }),
	).toThrow("Invalid adapters.shellPath");
});

test.skipIf(process.platform === "win32")(
	"direct argv resolves relative and empty PATH entries from the requested cwd",
	async () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-argv-path-")),
		);
		try {
			const tools = path.join(root, "tools");
			mkdirSync(tools);
			const main = executableFixture(root, "codelia-fixture-path", "cwd");
			const nested = executableFixture(
				tools,
				"codelia-fixture-path",
				"relative",
			);
			expect(
				resolveShellExecutable("codelia-fixture-path", ["tools", ""], root),
			).toBe(nested);
			expect(
				resolveShellExecutable("codelia-fixture-path", ["", "tools"], root),
			).toBe(main);
			const authorize = createShellAuthorizer({
				root,
				shellPath: "tools:",
				authority: fixtureShellAuthority,
				backend: fixtureShellBackend,
				dispatcher: new ApprovalDispatcher({ confirmation: approveFixture }),
			});
			expect(
				await authorize(
					{ cwd: root, origin: "parent_agent", argv: ["codelia-fixture-path"] },
					(admit) => capture(admit()),
				),
			).toBe("relative");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"normal shell context retains PATH while ambiguous search prefixes cannot reuse a saved launch",
	async () => {
		const base = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-save-path-")),
		);
		const root = path.join(base, "workspace");
		const hostBin = path.join(base, "host-bin");
		const localBin = path.join(root, "tools");
		const store = new LaunchRuleStore(path.join(base, "rules"));
		try {
			mkdirSync(localBin, { recursive: true });
			mkdirSync(hostBin);
			writeFileSync(path.join(root, "package.json"), "{}");
			executableFixture(hostBin, "bun", "host");
			executableFixture(localBin, "bun", "workspace");
			executableFixture(root, "bun", "cwd");
			const candidates: boolean[] = [];
			const dispatcher = new ApprovalDispatcher({
				confirmation: {
					confirm: async ({ requestId, choices }) => {
						const save = choices.includes("save_project");
						candidates.push(save);
						return { requestId, choice: save ? "save_project" : "allow_once" };
					},
				},
			});
			const launch = (shellPath: string) =>
				createShellAuthorizer({
					root,
					shellPath,
					authority: fixtureShellAuthority,
					launchRules: store,
					backend: fixtureShellBackend,
					dispatcher,
				})(
					{ cwd: root, origin: "parent_agent", source: "bun run typecheck" },
					(admit) => capture(admit()),
				);
			expect(await launch(hostBin)).toBe("host");
			expect(await launch(hostBin)).toBe("host");
			expect(candidates).toEqual([true]);
			expect(await launch(`${hostBin}:tools`)).toBe("host");
			// Even a later PATH entry can change subprocess lookup. The same
			// executable under a new command environment needs a new rule.
			expect(await launch(`${hostBin}:tools`)).toBe("host");
			expect(candidates).toEqual([true, true]);
			for (const prefix of ["tools", "", localBin]) {
				expect(await launch(`${prefix}:${hostBin}`)).toBe(
					prefix ? "workspace" : "cwd",
				);
			}
			expect(candidates).toEqual([true, true, false, false, false]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"only system commands and fixed Bash builtins receive policy shortcuts",
	async () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-read-command-")),
		);
		try {
			const tools = path.join(root, "tools");
			mkdirSync(tools);
			const fixture = executableFixture(tools, "uname", "fixture");
			const system = "/usr/bin:/bin";
			const uname = realpathSync("/usr/bin/uname");
			const directUnameIsSystem =
				uname === "/usr/bin/uname" || uname === "/bin/uname";
			const events: string[] = [];
			const dispatcher = new ApprovalDispatcher({
				confirmation: {
					confirm: async ({ requestId, route }) => {
						events.push(`manual:${route.profile}`);
						return { requestId, choice: "allow_once" };
					},
				},
				review: {
					categories: ["local_shell"],
					buildEvidence: async ({ input }) => {
						const { protection } = JSON.parse(input);
						events.push(`review:${protection.profile}`);
						return "Synthetic local inspection.";
					},
					review: async (_, _signal, request) => ({
						request_id: request.id,
						decision: "allow_once",
						reason: "Fixture approval.",
					}),
				},
			});
			const run = (
				sandboxMode: "workspace-write" | "full-access",
				shellPath: string,
				command: { source: string } | { argv: string[] },
			) =>
				createShellAuthorizer({
					root,
					sandboxMode,
					shellPath,
					autoReviewEnabled: () => true,
					authority: fixtureShellAuthority,
					backend: fixtureShellBackend,
					dispatcher,
				})({ cwd: root, origin: "parent_agent", ...command }, (admit) =>
					capture(admit()),
				);
			expect(await run("workspace-write", "", { source: "true" })).toBe("");
			expect(await run("workspace-write", system, { source: "uname" })).toBe(
				`${process.platform === "darwin" ? "Darwin" : "Linux"}\n`,
			);
			expect(events).toEqual([]);
			expect(
				await run("workspace-write", `tools:${system}`, { source: "uname" }),
			).toBe("fixture");
			expect(await run("full-access", system, { source: "uname" })).toMatch(
				/\n$/u,
			);
			expect(await run("full-access", system, { argv: ["uname"] })).toMatch(
				/\n$/u,
			);
			expect(
				await run("full-access", `tools:${system}`, { source: "uname" }),
			).toBe("fixture");
			expect(await run("full-access", system, { argv: [fixture] })).toBe(
				"fixture",
			);
			expect(
				await run("full-access", `tools:${system}`, { argv: ["uname"] }),
			).toBe("fixture");
			expect(events).toEqual([
				"review:investigation",
				"review:full-access",
				directUnameIsSystem ? "review:full-access" : "manual:full-access",
				"manual:full-access",
				"manual:full-access",
				"manual:full-access",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a custom shell backend must opt in to bound command policy shortcuts",
	async () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-sdk-command-binding-")),
		);
		try {
			const trueCommand = realpathSync("/usr/bin/true");
			const directTrueIsSystem =
				trueCommand === "/usr/bin/true" || trueCommand === "/bin/true";
			const backend: ProtectedShellBackend = {
				supports: fixtureShellBackend.supports,
				supportsReadOnlyPaths: fixtureShellBackend.supportsReadOnlyPaths,
				launch: fixtureShellBackend.launch,
			};
			const routes: string[] = [];
			const dispatcher = new ApprovalDispatcher({
				confirmation: approveFixture,
				audit: ({ actor, profile }) => routes.push(`${actor}:${profile}`),
				review: {
					categories: ["local_shell"],
					buildEvidence: async () => "Synthetic command inspection.",
					review: async (_, _signal, request) => ({
						request_id: request.id,
						decision: "allow_once",
						reason: "Fixture review.",
					}),
				},
			});
			for (const shellBackend of [backend, fixtureShellBackend]) {
				for (const sandboxMode of ["workspace-write", "full-access"] as const) {
					const run = createShellAuthorizer({
						root,
						sandboxMode,
						shellPath: "/usr/bin:/bin",
						autoReviewEnabled: () => true,
						authority: fixtureShellAuthority,
						backend: shellBackend,
						dispatcher,
					});
					for (const command of [{ source: "true" }, { argv: ["true"] }]) {
						const result = await run(
							{ cwd: root, origin: "parent_agent", ...command },
							(admit) => capture(admit()),
						);
						expect(result).toBe("");
					}
				}
			}
			expect(routes).toEqual([
				"review:investigation",
				directTrueIsSystem ? "review:investigation" : "review:development",
				"user:full-access",
				"user:full-access",
				"rule:investigation",
				directTrueIsSystem ? "rule:investigation" : "review:development",
				"review:full-access",
				directTrueIsSystem ? "review:full-access" : "user:full-access",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

const live =
	process.platform === "darwin" &&
	process.env.CODELIA_APPROVAL_MAC_LIVE === "1";
const drivers = ["direct", "full-access"];
if (process.arch === "arm64" && process.env.CODELIA_APPROVAL_MXC_LIVE === "1")
	drivers.push("mxc");

test.skipIf(!live).each(drivers)(
	"macOS %s shell resolves synthetic tools via inherited PATH and SDK override",
	async (driver) => {
		const base = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-native-path-")),
		);
		const root = path.join(base, "workspace");
		const originBin = path.join(base, "origin-bin");
		const sdkBin = path.join(base, "sdk bin");
		const relativeBin = path.join(root, "relative-tools");
		const keys = [
			"PATH",
			"CODELIA_MAC_SHELL_BACKEND",
			"CODELIA_LAYOUT",
			"XDG_CONFIG_HOME",
			"XDG_CACHE_HOME",
			"XDG_STATE_HOME",
			"CODELIA_CONFIG_PATH",
		] as const;
		const previous = keys.map((key) => [key, process.env[key]] as const);
		try {
			mkdirSync(root);
			mkdirSync(originBin);
			mkdirSync(sdkBin);
			mkdirSync(relativeBin);
			executableFixture(originBin, "codelia-fixture-path", "inherited");
			executableFixture(sdkBin, "codelia-fixture-path", "sdk");
			executableFixture(relativeBin, "codelia-fixture-path", "relative");
			executableFixture(root, "codelia-fixture-path", "cwd");
			process.env.PATH = originBin;
			process.env.CODELIA_MAC_SHELL_BACKEND =
				driver === "mxc" ? "mxc" : "seatbelt";
			process.env.CODELIA_LAYOUT = "xdg";
			process.env.XDG_CONFIG_HOME = path.join(base, "config");
			process.env.XDG_CACHE_HOME = path.join(base, "cache");
			process.env.XDG_STATE_HOME = path.join(base, "state");
			process.env.CODELIA_CONFIG_PATH = path.join(
				base,
				"config",
				"global.json",
			);
			const run = (shellPath?: string) => {
				const state = new RuntimeState();
				state.runtimeWorkingDir = state.runtimeSandboxRoot = root;
				state.setRuntimeEnvironment({
					adapters: {
						shellPath,
						approvalService: approveFixture,
						approvalShellAuthority: fixtureShellAuthority,
					},
				});
				if (driver === "full-access")
					state.sandboxMode = { value: "full-access", source: "fallback" };
				return authorizeRuntimeShell(state)(
					{ cwd: root, origin: "parent_agent", source: "codelia-fixture-path" },
					(admit) => capture(admit()),
				);
			};
			expect(await run()).toBe("inherited");
			expect(await run(sdkBin)).toBe("sdk");
			expect(await run("relative-tools:")).toBe("relative");
			expect(await run("")).toBe("cwd");
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(base, { recursive: true, force: true });
		}
	},
);
