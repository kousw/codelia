import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import {
	createMacMxcShellBackend,
	MacSeatbeltBackend,
	type ShellProtection,
} from "../src/permissions/shell-backend";

const enabled =
	process.platform === "darwin" &&
	process.env.CODELIA_APPROVAL_MAC_LIVE === "1";
const backends = ["direct"];
if (process.arch === "arm64" && process.env.CODELIA_APPROVAL_MXC_LIVE === "1")
	backends.push("MXC");

// The queried PIDs are this worker and its own spawned child. Return booleans
// rather than logging the account name or process table.
const probe = `
const { dlopen } = require("bun:ffi");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");

(async () => {
  const [node, account] = process.argv.slice(1);
  const sleep = spawn("/bin/sleep", ["5"], { stdio: "ignore" });
  const exited = new Promise((resolve) => {
    sleep.once("exit", (code, signal) => resolve([code, signal]));
  });
  let signalError;
  sleep.on("error", (error) => { signalError = error.code; });
  await once(sleep, "spawn");
  const whoami = spawnSync("/usr/bin/whoami", [], { encoding: "utf8" });
  const userInfo = spawnSync(node, ["-e", \`
    const info = require("node:os").userInfo();
    if (info.username !== process.argv[1] || info.uid !== process.getuid())
      process.exitCode = 1;
  \`, account]);
  const inspect = (pid) => {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid=,comm="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    const output = result.stdout?.trim();
    const selected = output?.match(/^(\\d+)\\s+[^\\r\\n]+$/u);
    return {
      status: result.status,
      output: Boolean(output),
      selected: Boolean(selected && Number(selected[1]) === pid),
      denied: ["EPERM", "EACCES"].includes(result.error?.code) ||
        /(?:operation not permitted|permission denied)/iu.test(result.stderr ?? ""),
    };
  };
  const psSelf = inspect(process.pid);
  const psChild = inspect(sleep.pid);
  const lib = dlopen("libSystem.B.dylib", {
    proc_name: { args: ["i32", "ptr", "u32"], returns: "i32" },
  });
  const childName = Buffer.alloc(128);
  const nameLength = lib.symbols.proc_name(sleep.pid, childName, childName.length);
  lib.close();
  let signalled = false;
  try {
    signalled = sleep.kill("SIGTERM");
  } catch (error) {
    signalError = error.code;
  }
  const [code, signal] = await exited;
  console.log(JSON.stringify({
    whoami: whoami.status === 0 && whoami.stdout?.trim() === account,
    userInfo: userInfo.status === 0,
    psSelf,
    psChild,
    childName: nameLength > 0 && childName.toString("utf8", 0, nameLength) === "sleep",
    signalError,
    signalled: signalled && code === null && signal === "SIGTERM",
  }));
})().catch((error) => { console.error(error.code ?? error.message); process.exitCode = 1; });
`;

test.skipIf(!enabled).each(backends)(
	"Seatbelt (%s) resolves the current account and can terminate its own child",
	async (driver) => {
		const node = Bun.which("node");
		if (!node)
			throw new Error("A Node executable is required for this fixture");
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-process-")),
		);
		try {
			const protection = {
				profile: "investigation",
				root,
				cwd: root,
				stdin: "closed",
				writeRoots: [],
				protectedPaths: [],
			} satisfies ShellProtection;
			const backend =
				driver === "MXC"
					? createMacMxcShellBackend()
					: new MacSeatbeltBackend();
			expect(backend.supports(protection)).toBe(true);
			const child = backend.launch(
				{
					kind: "argv",
					executable: realpathSync(process.execPath),
					args: ["-e", probe, realpathSync(node), userInfo().username],
				},
				protection,
			);
			const stdout = text(child.stdout);
			const stderr = text(child.stderr);
			const [code] = await once(child, "close");
			expect(code, await stderr).toBe(0);
			const result = JSON.parse(await stdout);
			expect(result).toMatchObject({
				whoami: true,
				userInfo: true,
				signalled: true,
				childName: true,
			});
			for (const probeResult of [result.psSelf, result.psChild]) {
				if (probeResult.status === 0) {
					expect(probeResult.selected).toBe(true);
				} else {
					expect(probeResult.output).toBe(false);
					expect(probeResult.denied).toBe(true);
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	10_000,
);
