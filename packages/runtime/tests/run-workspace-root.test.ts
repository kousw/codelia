import { describe, expect, test } from "bun:test";
import { resolveSessionWorkspaceRoot } from "../src/rpc/run";

describe("resolveSessionWorkspaceRoot", () => {
	test("prefers explicit ui workspace root", () => {
		expect(
			resolveSessionWorkspaceRoot({
				lastUiContext: { workspace_root: "/repo/root", cwd: "/repo/root/subdir" },
				agentsResolver: {
					getRootDir: () => "/repo/other",
				} as never,
				runtimeSandboxRoot: "/repo/fallback",
				runtimeWorkingDir: "/repo/fallback/subdir",
			}),
		).toBe("/repo/root");
	});

	test("falls back to agents resolver root before launch cwd", () => {
		expect(
			resolveSessionWorkspaceRoot({
				lastUiContext: null,
				agentsResolver: {
					getRootDir: () => "/repo/root",
				} as never,
				runtimeSandboxRoot: "/repo/root/subdir",
				runtimeWorkingDir: "/repo/root/subdir",
			}),
		).toBe("/repo/root");
	});
});
