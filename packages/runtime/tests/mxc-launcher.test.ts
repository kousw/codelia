import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StdioMcpClient } from "../src/mcp/stdio-client";
import {
	launchMxc,
	mxcLifecycle,
	probeMxcLauncher,
	resolveMxcLauncher,
} from "../src/permissions/mxc-launcher";
import {
	createMacMxcShellBackend,
	fixedBash,
	type ShellProtection,
} from "../src/permissions/shell-backend";
import { startShellTask } from "../src/tasks/shell-executor";

const live =
	process.platform === "darwin" &&
	process.arch === "arm64" &&
	process.env.CODELIA_APPROVAL_MXC_LIVE === "1";

const fixture = async (
	testCase: (protection: ShellProtection) => Promise<void>,
) => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-mxc-test-")),
	);
	try {
		await testCase({
			profile: "development",
			root,
			cwd: root,
			stdin: "pipe",
			writeRoots: [root],
			protectedPaths: [],
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

const detachedFixture = `
  const child = require('node:child_process').spawn('/bin/sleep', ['5'], { detached: true, stdio: 'ignore' });
  child.unref();
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: child.pid }));
  });
`;

describe.skipIf(!live)("macOS arm64 MXC", () => {
	test("probe has a hard deadline even if its process ignores SIGTERM", () =>
		fixture(async ({ root }) => {
			const file = path.join(root, "probe-fixture");
			writeFileSync(file, "#!/bin/sh\ntrap '' TERM\nexec /bin/sleep 8\n", {
				mode: 0o700,
			});
			const started = performance.now();
			expect(probeMxcLauncher({ file, identity: "fixture" })).toBe(false);
			expect(performance.now() - started).toBeLessThan(5000);
		}));
	test("fast commands and workload exit 125 carry a confirmed report", () =>
		fixture(async (protection) => {
			const backend = createMacMxcShellBackend();
			for (const args of [
				["/usr/bin/true", [], 0],
				["/bin/sh", ["-c", "exit 125"], 125],
			] as const) {
				const [executable, argv, code] = args;
				const child = backend.launch(
					{ kind: "argv", executable, args: argv },
					protection,
				);
				const closed = once(child, "close");
				child.stdin?.end();
				await expect(mxcLifecycle(child)?.completed).resolves.toBe("clean");
				expect(await closed).toEqual([code, null]);
			}
			const launcher = resolveMxcLauncher(protection);
			if (!launcher) throw new Error("missing native fixture launcher");
			const failure = launchMxc(
				launcher,
				{
					executable: "/usr/bin/true",
					args: [],
					cwd: protection.cwd,
					profile: "invalid fixture profile",
					path: "/usr/bin:/bin",
					scratch: protection.root,
				},
				"closed",
			);
			await expect(mxcLifecycle(failure)?.completed).resolves.toBe(
				"unconfirmed",
			);
			expect(failure.exitCode).toBe(125);
		}));

	test("shell task pipes stdin and holds cancellation until the SDK reports cleanup", () =>
		fixture(async (protection) => {
			const backend = createMacMxcShellBackend();
			const code = "IFS= read -r line; printf '%s' \"$line\"; /bin/sleep 5";
			const child = backend.launch(fixedBash(code), protection);
			const output = once(child.stdout, "data");
			const task = startShellTask({
				taskId: "mxc-stdin",
				command: code,
				cwd: protection.cwd,
				stdinMode: "pipe",
				outputCache: {
					save: async () => {
						throw new Error("unexpected cache write");
					},
				},
				spawnProcess: () => child,
			});
			const metadata = await task.metadata;
			expect(metadata?.executor_pid).toBeUndefined();
			expect(metadata?.executor_pgid).toBeUndefined();
			await task.writeInput?.({ text: "fixture 'líne'\n", close: true });
			expect(String((await output)[0])).toBe("fixture 'líne'");
			await task.cancel?.();
			await expect(task.wait).resolves.toMatchObject({
				state: "cancelled",
				result: { exit_code: 143 },
			});
			await expect(mxcLifecycle(child)?.completed).resolves.toBe("clean");
		}));

	test.each([false, true])(
		"MCP reports cleanup accurately and reaps detached descendants (supervisor crash: %s)",
		(abrupt) =>
			fixture(async (protection) => {
				const backend = createMacMxcShellBackend();
				const executable = realpathSync(process.execPath);
				const args = ["-e", detachedFixture];
				const child = backend.launch(
					{ kind: "argv", executable, args },
					protection,
				);
				const client = new StdioMcpClient(
					{ serverId: "mxc-test", command: executable, args, log: () => {} },
					child,
				);
				try {
					const pid = await client.request("fixture", {}, { timeoutMs: 1000 });
					expect(typeof pid).toBe("number");
					if (typeof pid !== "number")
						throw new Error("missing detached fixture PID");
					process.kill(pid, 0);
					if (abrupt) {
						child.kill("SIGKILL");
						await expect(client.close()).rejects.toThrow(
							"could not confirm MCP process cleanup",
						);
						await expect(mxcLifecycle(child)?.completed).resolves.toBe(
							"unconfirmed",
						);
					} else {
						await client.close();
						await expect(mxcLifecycle(child)?.completed).resolves.toBe("clean");
					}
					expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
				} finally {
					await client.close().catch(() => {});
				}
			}),
	);
});
