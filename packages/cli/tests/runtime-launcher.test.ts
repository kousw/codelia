import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	buildTuiArgs,
	buildTuiLaunchContext,
	resolveBundledRuntimeLaunch,
	resolveOptionalTuiBinaryPath,
	resolvePlatformTuiPackageName,
	resolveTuiCommand,
	TUI_LAUNCH_CONTEXT_FLAG,
} from "../src/tui/launcher";
import { NOOP_LAUNCH_UPDATE_SESSION } from "../src/update/launch";

describe("resolveBundledRuntimeLaunch", () => {
	test("leaves the developer override to the TUI", () => {
		expect(
			resolveBundledRuntimeLaunch(
				{ CODELIA_RUNTIME_CMD: "bun" },
				() => "/ignored/runtime",
			),
		).toBeUndefined();
		expect(
			resolveBundledRuntimeLaunch(
				{ CODELIA_RUNTIME_ARGS: "/custom/runtime.js" },
				() => "/ignored/runtime",
			),
		).toBeUndefined();
	});

	test("returns the bundled runtime as an argument array", () => {
		const runtimeEntry =
			"C:\\Program Files\\Codelia\\O'Neill\\runtime\\index.cjs";
		expect(resolveBundledRuntimeLaunch({}, () => runtimeEntry)).toEqual({
			command: process.execPath,
			args: [runtimeEntry],
		});
	});

	test("returns nothing when the bundled runtime cannot be resolved", () => {
		expect(resolveBundledRuntimeLaunch({}, () => null)).toBeUndefined();
	});
});

describe("buildTuiLaunchContext", () => {
	test("carries launcher-owned values without touching the environment", () => {
		const env: NodeJS.ProcessEnv = {};
		const context = buildTuiLaunchContext({
			env,
			cliVersion: " 1.2.3 ",
			update: {
				...NOOP_LAUNCH_UPDATE_SESSION,
				noticeFile: "/tmp/notice.json",
				startupConfirmations: ["update-mode"],
			},
			launcherEntry: "bin/codelia.js",
			resolveRuntimeEntry: () => "/opt/runtime/index.cjs",
		});
		expect(context).toEqual({
			cli_version: "1.2.3",
			runtime: { command: process.execPath, args: ["/opt/runtime/index.cjs"] },
			update_notice_file: "/tmp/notice.json",
			update_control: {
				node: process.execPath,
				entry: path.resolve("bin/codelia.js"),
			},
			startup_confirmations: ["update-mode"],
		});
		expect(env).toEqual({});
	});

	test("omits values the launcher does not own", () => {
		expect(
			buildTuiLaunchContext({
				env: { CODELIA_RUNTIME_CMD: "bun" },
				cliVersion: "",
				resolveRuntimeEntry: () => "/opt/runtime/index.cjs",
			}),
		).toEqual({});
	});
});

describe("buildTuiArgs", () => {
	test("prepends the context and drops forwarded copies", () => {
		const args = buildTuiArgs({ cli_version: "1.2.3" }, [
			"--resume",
			`${TUI_LAUNCH_CONTEXT_FLAG}={"cli_version":"9.9.9"}`,
			TUI_LAUNCH_CONTEXT_FLAG,
			"--debug",
		]);
		expect(args).toEqual([
			`${TUI_LAUNCH_CONTEXT_FLAG}={"cli_version":"1.2.3"}`,
			"--resume",
			"--debug",
		]);
	});

	test("keeps CODELIA_TUI_ARGS wrapper arguments before the launch context", () => {
		const args = buildTuiArgs(
			{ cli_version: "1.2.3" },
			["--resume"],
			["run", "--manifest-path", "crates/tui/Cargo.toml", "--"],
		);
		expect(args).toEqual([
			"run",
			"--manifest-path",
			"crates/tui/Cargo.toml",
			"--",
			`${TUI_LAUNCH_CONTEXT_FLAG}={"cli_version":"1.2.3"}`,
			"--resume",
		]);
	});
});

describe("resolvePlatformTuiPackageName", () => {
	test("maps supported target to package name", () => {
		expect(resolvePlatformTuiPackageName("linux", "x64")).toBe(
			"@codelia/tui-linux-x64",
		);
		expect(resolvePlatformTuiPackageName("darwin", "arm64")).toBe(
			"@codelia/tui-darwin-arm64",
		);
	});

	test("returns null for unsupported target", () => {
		expect(resolvePlatformTuiPackageName("freebsd", "x64")).toBeNull();
	});
});

describe("resolveOptionalTuiBinaryPath", () => {
	test("returns package bin path when platform package is resolvable", () => {
		const resolved = resolveOptionalTuiBinaryPath(
			"linux",
			"x64",
			(packageName) =>
				packageName === "@codelia/tui-linux-x64"
					? "/tmp/node_modules/@codelia/tui-linux-x64/package.json"
					: null,
		);
		expect(resolved).toBe(
			"/tmp/node_modules/@codelia/tui-linux-x64/bin/codelia-tui",
		);
	});

	test("returns null when platform package is unsupported or missing", () => {
		expect(
			resolveOptionalTuiBinaryPath("freebsd", "x64", () => null),
		).toBeNull();
		expect(resolveOptionalTuiBinaryPath("linux", "x64", () => null)).toBeNull();
	});
});

describe("resolveTuiCommand", () => {
	test("prefers CODELIA_TUI_CMD when configured", () => {
		expect(
			resolveTuiCommand({
				env: { CODELIA_TUI_CMD: "/custom/tui" },
				isExecutableCandidate: () => false,
			}),
		).toBe("/custom/tui");
	});

	test("falls back to optional dependency binary when local candidates are absent", () => {
		const optionalBinary =
			"/tmp/node_modules/@codelia/tui-linux-x64/bin/codelia-tui";
		expect(
			resolveTuiCommand({
				platform: "linux",
				arch: "x64",
				cwd: "/repo",
				cliPackageRoot: "/repo/packages/cli",
				resolveOptionalTuiBinary: () => optionalBinary,
				isExecutableCandidate: (candidate) => candidate === optionalBinary,
			}),
		).toBe(optionalBinary);
	});

	test("prefers local workspace binary over optional dependency binary", () => {
		const localBinary = "/repo/crates/tui/target/debug/codelia-tui";
		const optionalBinary =
			"/tmp/node_modules/@codelia/tui-linux-x64/bin/codelia-tui";
		expect(
			resolveTuiCommand({
				platform: "linux",
				arch: "x64",
				cwd: "/repo",
				cliPackageRoot: "/repo/packages/cli",
				resolveOptionalTuiBinary: () => optionalBinary,
				isExecutableCandidate: (candidate) =>
					candidate === localBinary || candidate === optionalBinary,
			}),
		).toBe(localBinary);
	});

	test("falls back to binary name when candidates are not executable", () => {
		expect(
			resolveTuiCommand({
				platform: "linux",
				arch: "x64",
				cwd: "/repo",
				cliPackageRoot: "/repo/packages/cli",
				resolveOptionalTuiBinary: () => null,
				isExecutableCandidate: () => false,
			}),
		).toBe("codelia-tui");
	});
});
