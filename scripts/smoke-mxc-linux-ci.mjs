import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const load = createRequire(path.join(process.argv[2], "package.json"));
const report = { kernel: os.release(), arch: process.arch, status: "not_started" };
try {
  const sdk = await import(pathToFileURL(load.resolve("@microsoft/mxc-sdk/v1")).href);
  report.support = sdk.getPlatformSupport();
  if (!report.support.availableMethods.includes("bubblewrap")) {
    report.status = "sandbox_unavailable";
    process.exitCode = 1;
  } else {
    const output = await sdk.run({
      containment: { type: "process" },
      command: "/usr/bin/printf codelia-mxc-ok",
      workingDirectory: "/usr",
      inheritDefaultEnvironment: false,
      filesystem: { readonlyPaths: ["/usr", "/bin", "/lib", "/lib64"].filter(existsSync) },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      timeoutMs: 15000,
    });
    report.exitCode = output.exitCode;
    report.stdoutMatches = output.stdout === "codelia-mxc-ok";
    report.status = output.exitCode === 0 && report.stdoutMatches ? "native_command_passed" : "native_command_failed";
    if (report.status !== "native_command_passed") process.exitCode = 1;
  }
} catch (error) {
  report.status = "sdk_or_launch_failed";
  report.error = String(error.message).slice(0, 1000);
  process.exitCode = 1;
}
console.log(JSON.stringify(report, null, 2));
