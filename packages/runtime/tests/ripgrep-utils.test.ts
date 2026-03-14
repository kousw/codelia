import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRipgrepLines } from "../src/utils/ripgrep";

const createTempDir = async (): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), "codelia-ripgrep-test-"));

const createFakeRipgrepEnv = async (options: {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}): Promise<NodeJS.ProcessEnv> => {
	const binDir = await createTempDir();
	const scriptPath = path.join(binDir, "rg.js");
	await fs.writeFile(
		scriptPath,
		[
			`process.stdout.write(${JSON.stringify(options.stdout ?? "")});`,
			`process.stderr.write(${JSON.stringify(options.stderr ?? "")});`,
			`process.exit(${String(options.exitCode ?? 0)});`,
		].join("\n"),
		"utf8",
	);
	if (process.platform === "win32") {
		await fs.writeFile(
			path.join(binDir, "rg.cmd"),
			`@echo off\r\n"${process.execPath}" "%~dp0\\rg.js" %*\r\n`,
			"utf8",
		);
	} else {
		const shimPath = path.join(binDir, "rg");
		await fs.writeFile(
			shimPath,
			`#!/bin/sh\n"${process.execPath}" "$(dirname "$0")/rg.js" "$@"\n`,
			"utf8",
		);
		await fs.chmod(shimPath, 0o755);
	}
	return {
		...process.env,
		PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
	};
};

describe("ripgrep utils", () => {
	test("reports missing ripgrep when it is unavailable in the provided env", async () => {
		const tempRoot = await createTempDir();
		const emptyBinDir = await createTempDir();
		try {
			const result = await runRipgrepLines(["--version"], {
				cwd: tempRoot,
				env: {
					...process.env,
					PATH: emptyBinDir,
				},
				onLine: () => true,
			});
			expect(result.status).toBe("missing");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
			await fs.rm(emptyBinDir, { recursive: true, force: true });
		}
	});

	test("surfaces line-processing errors from ripgrep output", async () => {
		const tempRoot = await createTempDir();
		const env = await createFakeRipgrepEnv({
			stdout: "not-json\n",
			exitCode: 0,
		});
		try {
			const result = await runRipgrepLines([], {
				cwd: tempRoot,
				env,
				onLine: (line) => {
					JSON.parse(line);
					return true;
				},
			});
			expect(result.status).toBe("error");
			if (result.status !== "error") throw new Error("unexpected result");
			expect(result.error).toContain("Failed to process ripgrep output:");
			expect(result.error).toContain("SyntaxError");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
			const fakeBinDir = env.PATH?.split(path.delimiter)[0];
			if (fakeBinDir) {
				await fs.rm(fakeBinDir, { recursive: true, force: true });
			}
		}
	});
});
