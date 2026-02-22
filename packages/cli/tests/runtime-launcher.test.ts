import { describe, expect, test } from "bun:test";
import {
	resolveLaunchEnvForTui,
	resolveOptionalTuiBinaryPath,
	resolvePlatformTuiPackageName,
	resolveRuntimeEnvForTui,
	resolveTuiCommand,
} from "../src/tui/launcher";

describe("resolveRuntimeEnvForTui", () => {
	test("keeps existing runtime env when already configured", () => {
		const baseEnv: NodeJS.ProcessEnv = {
			CODELIA_RUNTIME_CMD: "bun",
			CODELIA_RUNTIME_ARGS: "/custom/runtime.js",
		};
		const resolved = resolveRuntimeEnvForTui(baseEnv, () => "/ignored/runtime");
		expect(resolved).toBe(baseEnv);
		expect(resolved.CODELIA_RUNTIME_CMD).toBe("bun");
		expect(resolved.CODELIA_RUNTIME_ARGS).toBe("/custom/runtime.js");
	});

	test("injects node runtime env when bundled runtime is resolvable", () => {
		const baseEnv: NodeJS.ProcessEnv = {};
		const runtimeEntry = "/tmp/node_modules/@codelia/runtime/dist/index.cjs";
		const resolved = resolveRuntimeEnvForTui(baseEnv, () => runtimeEntry);
		expect(resolved).not.toBe(baseEnv);
		expect(resolved.CODELIA_RUNTIME_CMD).toBe(process.execPath);
		expect(resolved.CODELIA_RUNTIME_ARGS).toBe(
			"'/tmp/node_modules/@codelia/runtime/dist/index.cjs'",
		);
	});

	test("quotes runtime entry for shell splitting compatibility", () => {
		const baseEnv: NodeJS.ProcessEnv = {};
		const runtimeEntry =
			"C:\\Program Files\\Codelia\\O'Neill\\runtime\\index.cjs";
		const resolved = resolveRuntimeEnvForTui(baseEnv, () => runtimeEntry);
		expect(resolved.CODELIA_RUNTIME_ARGS).toBe(
			"'C:\\Program Files\\Codelia\\O'\\''Neill\\runtime\\index.cjs'",
		);
	});

	test("keeps env unchanged when bundled runtime cannot be resolved", () => {
		const baseEnv: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
		};
		const resolved = resolveRuntimeEnvForTui(baseEnv, () => null);
		expect(resolved).toBe(baseEnv);
		expect(resolved.CODELIA_RUNTIME_CMD).toBeUndefined();
		expect(resolved.CODELIA_RUNTIME_ARGS).toBeUndefined();
	});

});

describe("resolveLaunchEnvForTui", () => {
	test("adds CODELIA_CLI_VERSION when missing", () => {
		const env: NodeJS.ProcessEnv = {};
		const resolved = resolveLaunchEnvForTui(env, "1.2.3", () => null);
		expect(resolved.CODELIA_CLI_VERSION).toBe("1.2.3");
	});

	test("keeps existing CODELIA_CLI_VERSION", () => {
		const env: NodeJS.ProcessEnv = {
			CODELIA_CLI_VERSION: "9.9.9",
		};
		const resolved = resolveLaunchEnvForTui(env, "1.2.3", () => null);
		expect(resolved).toBe(env);
		expect(resolved.CODELIA_CLI_VERSION).toBe("9.9.9");
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
