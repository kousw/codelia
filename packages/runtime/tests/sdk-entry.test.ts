import { describe, expect, test } from "bun:test";

describe("runtime SDK entrypoint", () => {
	test("exports configurable startup without running the stdio entrypoint", async () => {
		const sdk = await import("../src/sdk");
		const packageJson = (await Bun.file(
			new URL("../package.json", import.meta.url),
		).json()) as {
			exports?: Record<string, unknown>;
		};

		expect(typeof sdk.startRuntime).toBe("function");
		expect(packageJson.exports?.["./sdk"]).toEqual({
			types: "./dist/sdk.d.ts",
			import: "./dist/sdk.js",
			require: "./dist/sdk.cjs",
		});
	});

	test("rejects invalid startup options for the embedding host to handle", async () => {
		const { startRuntime } = await import("../src/sdk");

		await expect(
			startRuntime({
				environment: { preset: "embedded-no-local-tools" },
			}),
		).rejects.toThrow("adapters.systemPromptProvider");
	});
});
