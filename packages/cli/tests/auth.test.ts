import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("authorize-keychain exits before helper lookup when run without a terminal", () => {
	const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
	const result = Bun.spawnSync(
		[process.execPath, cli, "auth", "authorize-keychain"],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);

	expect(result.exitCode).toBe(1);
	expect(result.stdout.toString()).toBe("");
	expect(result.stderr.toString()).toBe(
		"Run this command from a local macOS terminal.\n",
	);
});
