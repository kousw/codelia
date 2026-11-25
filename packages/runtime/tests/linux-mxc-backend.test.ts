import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { hasHomeDotHardLinkAliases } from "../src/permissions/home-dot-paths";
import {
	buildLinuxMxcFilesystemPolicy,
	DEFAULT_LINUX_MXC_READABLE_ROOTS,
	LinuxMxcBackend,
	resolveLinuxBwrap,
} from "../src/permissions/linux-mxc-backend";
import {
	mxcLifecycle,
	probeMxcLauncher,
	resolveMxcLauncher,
} from "../src/permissions/mxc-launcher";
import {
	createLinuxMxcShellBackend,
	fixedBash,
	type ShellChild,
	type ShellProtection,
	workspacePathProtection,
} from "../src/permissions/shell-backend";
import { startShellTask, terminateChild } from "../src/tasks/shell-executor";

async function finish(child: ShellChild) {
	const [[code], stdout, stderr] = await Promise.all([
		once(child, "close"),
		Array.fromAsync(child.stdout),
		Array.fromAsync(child.stderr),
	]);
	if (code !== 0)
		throw new Error(
			`Child exit ${code}: ${Buffer.concat(stderr).toString().slice(0, 500)}`,
		);
	return { code, text: Buffer.concat(stdout).toString() };
}

describe.skipIf(process.platform === "win32")(
	"Linux MXC filesystem policy builder",
	() => {
		let fixture: string;
		let scratch: string;
		let workspace: string;

		beforeEach(() => {
			fixture = realpathSync(
				mkdtempSync(path.join(tmpdir(), "codelia-linux-mxc-unit-")),
			);
			scratch = path.join(fixture, "scratch");
			workspace = path.join(fixture, "work");
			mkdirSync(scratch, { recursive: true });
			mkdirSync(workspace, { recursive: true });
		});

		afterEach(() => {
			rmSync(fixture, { recursive: true, force: true });
		});

		test("default readable roots narrow /nix to /nix/store and exclude /var/lib", () => {
			expect(DEFAULT_LINUX_MXC_READABLE_ROOTS).toContain("/nix/store");
			expect(DEFAULT_LINUX_MXC_READABLE_ROOTS).not.toContain("/nix");
			expect(DEFAULT_LINUX_MXC_READABLE_ROOTS).not.toContain("/var/lib");
		});

		test("maps development/investigation roots, read-only mounts, anchors, and denied paths", () => {
			const secretFile = path.join(fixture, "secret.txt");
			const projectDir = path.join(workspace, ".codelia");
			const metadataAdmin = path.join(workspace, "metadata", "admin");
			mkdirSync(projectDir, { recursive: true });
			mkdirSync(metadataAdmin, { recursive: true });
			writeFileSync(secretFile, "private");
			writeFileSync(path.join(metadataAdmin, "HEAD"), "ref: refs/heads/main\n");

			const readableRoot = path.join(fixture, "readable-root");
			mkdirSync(readableRoot, { recursive: true });

			const development: ShellProtection = {
				profile: "development",
				root: workspace,
				cwd: workspace,
				writeRoots: [workspace],
				protectedPaths: [secretFile],
				readOnlyPaths: [projectDir, metadataAdmin],
				stdin: "closed",
			};
			const spec = buildLinuxMxcFilesystemPolicy(development, scratch, {
				readableRoots: [readableRoot],
				homeDir: fixture,
			});
			expect(spec.readwrite_paths).toContain(workspace);
			expect(spec.readwrite_paths).toContain(scratch);
			// Mutable ancestor of nested read-only mount is anchored as its own rw bind.
			expect(spec.readwrite_paths).toContain(path.join(workspace, "metadata"));
			expect(spec.readonly_paths).toContain(readableRoot);
			expect(spec.readonly_paths).toContain(projectDir);
			expect(spec.readonly_paths).toContain(metadataAdmin);
			expect(spec.denied_paths).toEqual([secretFile]);
			// Workspace must not also appear in readonly_paths (most-restrictive-wins).
			expect(spec.readonly_paths).not.toContain(workspace);
			expect(spec.readonly_paths).not.toContain(scratch);
			for (const forbidden of [
				"/",
				"/tmp",
				"/run",
				"/var/run",
				"/dev",
				"/proc",
				"/sys",
			]) {
				expect(spec.readonly_paths).not.toContain(forbidden);
				expect(spec.readwrite_paths).not.toContain(forbidden);
			}

			const investigation = buildLinuxMxcFilesystemPolicy(
				{
					...development,
					profile: "investigation",
					writeRoots: [],
				},
				scratch,
				{ readableRoots: [readableRoot], homeDir: fixture },
			);
			expect(investigation.readwrite_paths).toEqual([scratch]);
			expect(investigation.readonly_paths).toContain(fixture);
			expect(investigation.denied_paths).toEqual([secretFile]);
		});

		test("rejects full-access, investigation writeRoots, /tmp writeRoot, gitWriteRoots, absent protectedPaths, and absent readOnlyPaths", () => {
			const missingSecret = path.join(fixture, "absent-secret");
			const missingCodelia = path.join(workspace, ".codelia");
			const base: ShellProtection = {
				profile: "development",
				root: workspace,
				cwd: workspace,
				writeRoots: [workspace],
				protectedPaths: [],
				readOnlyPaths: [],
				stdin: "closed",
			};

			expect(() =>
				buildLinuxMxcFilesystemPolicy(
					{ ...base, profile: "full-access" },
					scratch,
				),
			).toThrow("unsupported_protection");
			expect(() =>
				buildLinuxMxcFilesystemPolicy(
					{ ...base, profile: "investigation", writeRoots: [workspace] },
					scratch,
				),
			).toThrow("unsupported_protection");
			expect(() =>
				buildLinuxMxcFilesystemPolicy(
					{ ...base, writeRoots: [workspace, "/tmp"] },
					scratch,
				),
			).toThrow("invalid_write_root");
			expect(() =>
				buildLinuxMxcFilesystemPolicy(
					{ ...base, gitWriteRoots: [path.join(workspace, ".git")] },
					scratch,
				),
			).toThrow("unsupported_protection");
			expect(() =>
				buildLinuxMxcFilesystemPolicy(
					{ ...base, gitProtectedPaths: [path.join(workspace, ".git/config")] },
					scratch,
				),
			).toThrow("unsupported_protection");
			expect(() =>
				buildLinuxMxcFilesystemPolicy(
					{ ...base, protectedPaths: [missingSecret] },
					scratch,
				),
			).toThrow("missing_protected_mountpoint");
			expect(existsSync(missingSecret)).toBe(false);
			expect(() =>
				buildLinuxMxcFilesystemPolicy(
					{ ...base, readOnlyPaths: [missingCodelia] },
					scratch,
				),
			).toThrow();
		});

		test("accepts a Unix domain socket in protectedPaths for file masking", async () => {
			const shortDir = realpathSync(mkdtempSync("/tmp/codelia-sock-"));
			const socketPath = path.join(shortDir, "agent.sock");
			const server = createServer((peer) => peer.destroy());
			try {
				server.listen(socketPath);
				await once(server, "listening");
				const spec = buildLinuxMxcFilesystemPolicy(
					{
						profile: "development",
						root: workspace,
						cwd: workspace,
						writeRoots: [workspace],
						protectedPaths: [socketPath],
						readOnlyPaths: [],
						stdin: "closed",
					},
					scratch,
					{ readableRoots: [], homeDir: fixture },
				);
				expect(spec.denied_paths).toContain(socketPath);
			} finally {
				server.close();
				rmSync(shortDir, { recursive: true, force: true });
			}
		});

		test("projects home-directory workspaces without exposing dotfiles or symlinks as writable and detects dotfile hard-link aliases", () => {
			const homeDir = path.join(fixture, "home");
			const project = path.join(homeDir, "project");
			const settings = path.join(homeDir, ".settings");
			const xdgConfig = path.join(homeDir, ".config", "codelia");
			const secret = path.join(xdgConfig, "credentials");
			const external = path.join(fixture, "external");
			mkdirSync(project, { recursive: true });
			mkdirSync(settings, { recursive: true });
			mkdirSync(secret, { recursive: true });
			mkdirSync(external, { recursive: true });
			writeFileSync(path.join(homeDir, ".zshrc"), "export SAFE=1\n");
			symlinkSync(project, path.join(homeDir, "project-link"));
			symlinkSync(external, path.join(homeDir, "external-link"));

			expect(hasHomeDotHardLinkAliases(homeDir)).toBe(false);

			const spec = buildLinuxMxcFilesystemPolicy(
				{
					profile: "development",
					root: homeDir,
					cwd: homeDir,
					writeRoots: [homeDir],
					homeDotDirectory: homeDir,
					protectedPaths: [secret],
					readOnlyPaths: [xdgConfig],
					stdin: "closed",
				},
				scratch,
				{ readableRoots: [], homeDir },
			);
			expect(spec.readonly_paths).toContain(homeDir);
			expect(spec.readwrite_paths).toContain(project);
			expect(spec.readwrite_paths).not.toContain(homeDir);
			expect(spec.readwrite_paths).not.toContain(settings);
			expect(spec.readwrite_paths).not.toContain(
				path.join(homeDir, "project-link"),
			);
			expect(spec.readwrite_paths).not.toContain(
				path.join(homeDir, "external-link"),
			);
			expect(spec.denied_paths).toEqual([secret]);

			const approved = buildLinuxMxcFilesystemPolicy(
				{
					profile: "development",
					root: homeDir,
					cwd: homeDir,
					writeRoots: [homeDir, settings, external],
					homeDotDirectory: homeDir,
					protectedPaths: [secret],
					readOnlyPaths: [xdgConfig],
					stdin: "closed",
				},
				scratch,
				{ readableRoots: [], homeDir },
			);
			expect(approved.readwrite_paths).toContain(settings);
			expect(approved.readwrite_paths).toContain(external);
			expect(approved.readwrite_paths).not.toContain(
				path.join(homeDir, ".config"),
			);

			// Hard-linking a top-level dotfile into an ordinary child is detected.
			const alias = path.join(project, "zshrc-alias");
			linkSync(path.join(homeDir, ".zshrc"), alias);
			expect(hasHomeDotHardLinkAliases(homeDir)).toBe(true);
			rmSync(alias);
			expect(hasHomeDotHardLinkAliases(homeDir)).toBe(false);

			// Hard-linking inside ~/.ssh is also detected.
			mkdirSync(path.join(homeDir, ".ssh"), { recursive: true });
			writeFileSync(path.join(homeDir, ".ssh", "config"), "Host *\n");
			linkSync(
				path.join(homeDir, ".ssh", "config"),
				path.join(project, "ssh-alias"),
			);
			expect(hasHomeDotHardLinkAliases(homeDir)).toBe(true);
		});

		test("rejects oversized filesystem policies before launch", () => {
			const homeDir = path.join(fixture, "huge-home");
			mkdirSync(homeDir, { recursive: true });
			// Create enough long-named files to push the serialized policy past 240 KiB.
			const pad = "a".repeat(120);
			for (let i = 0; i < 1600; i += 1) {
				writeFileSync(path.join(homeDir, `${pad}-${i}`), "");
			}
			expect(() =>
				buildLinuxMxcFilesystemPolicy(
					{
						profile: "development",
						root: homeDir,
						cwd: homeDir,
						writeRoots: [homeDir],
						homeDotDirectory: homeDir,
						protectedPaths: [],
						readOnlyPaths: [],
						stdin: "closed",
					},
					scratch,
					{ readableRoots: [], homeDir },
				),
			).toThrow("filesystem_policy_too_large");
		});

		test("backend capability flags keep absent-path denial disabled", () => {
			const backend = createLinuxMxcShellBackend();
			expect(backend).toBeInstanceOf(LinuxMxcBackend);
			expect(backend.supportsReadOnlyPaths).toBe(true);
			expect(backend.supportsHomeDotProtection).toBe(true);
			expect(backend.supportsCommandBinding).toBe(true);
			expect("supportsAbsentPathDenial" in backend).toBe(false);
			expect(backend.exactLaunchBindingId).toBe("codelia.linux.mxc/v1");
		});
	},
);

const liveLinuxMxc =
	process.platform === "linux" &&
	process.env.CODELIA_APPROVAL_LINUX_MXC_LIVE === "1";

const linuxMxcFixtureScript = `
const fs = require("node:fs");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const [sibling, secret, secretDir, maskedSocket, hostTmpSocket, port] = process.argv.slice(1);
function allowed(operation) {
  try { operation(); return true; } catch { return false; }
}
function connects(endpoint) {
  return new Promise(resolve => {
    const peer = net.connect(endpoint);
    peer.once("connect", () => { peer.destroy(); resolve(true); });
    peer.once("error", () => resolve(false));
    peer.setTimeout(1500, () => { peer.destroy(); resolve(false); });
  });
}
const gitHead = "metadata/admin/HEAD";
const result = {
  home: process.env.HOME,
  sibling: fs.readFileSync(sibling, "utf8"),
  protectedView: fs.readFileSync(secret, "utf8"),
  descendantView: spawnSync("/bin/cat", [secret], { encoding: "utf8" }).stdout,
  protectedDirEntries: fs.readdirSync(secretDir),
  protectedWrite: allowed(() => fs.writeFileSync(secret, "changed")),
  protectedDirWrite: allowed(() => fs.writeFileSync(secretDir + "/x", "changed")),
  outsideWrite: allowed(() => fs.writeFileSync(sibling, "changed")),
  insideWrite: allowed(() => fs.writeFileSync("result", "development")),
  sharedWrite: allowed(() => fs.writeFileSync("shared", "updated")),
  newExternalLink: allowed(() => fs.linkSync(sibling, "imported-link")),
  externalSymlinkWrite: allowed(() => fs.writeFileSync("sibling-ref", "changed")),
  gitMarker: fs.readFileSync(".git", "utf8"),
  gitHead: fs.readFileSync(gitHead, "utf8"),
  projectConfig: fs.readFileSync(".codelia/config.json", "utf8"),
  projectConfigWrite: allowed(() => fs.writeFileSync(".codelia/config.json", "changed")),
  moveProjectConfig: allowed(() => fs.renameSync(".codelia", "moved-config")),
  gitWrite: allowed(() => fs.writeFileSync(gitHead, "changed")),
  moveMetadata: allowed(() => fs.renameSync("metadata", "relocated")),
  reservedWrite: allowed(() => fs.writeFileSync(".env", "fixture")),
  scratch: allowed(() => fs.writeFileSync(process.env.TMPDIR + "/scratch", "ok")),
  network: await connects({ host: "127.0.0.1", port: Number(port) }),
  maskedHomeSocket: await connects(maskedSocket),
  hostTmpIpc: await connects(hostTmpSocket),
};
process.stdout.write(JSON.stringify(result));
`;

describe.skipIf(!liveLinuxMxc)("Linux MXC Bubblewrap live acceptance", () => {
	test("enforces workspace, Git, protected files/dirs/sockets, PATH sh isolation, private scratch, network, stdin, exit 125 and detached descendant cleanup", async () => {
		const directory = realpathSync(
			mkdtempSync(path.join(homedir(), "codelia-linux-mxc-live-")),
		);
		const tmpSocketDir = realpathSync(
			mkdtempSync(path.join("/tmp", "codelia-mxc-sock-")),
		);
		const workspace = path.join(directory, "work");
		const sibling = path.join(directory, "adjacent");
		const secret = path.join(directory, "private");
		const secretDir = path.join(directory, "private-dir");
		const maskedSocket = path.join(directory, "masked.sock");
		const shared = path.join(directory, "existing-shared");
		const incoming = path.join(directory, "new-private");
		const reserved = path.join(workspace, ".env");
		const projectDirectory = path.join(workspace, ".codelia");
		const gitHead = path.join(workspace, "metadata/admin/HEAD");
		const marker = "gitdir: metadata/admin";
		const hostTmpSocket = path.join(tmpSocketDir, "service.sock");
		const host = createServer((peer) => peer.destroy());
		const unixTmp = createServer((peer) => peer.destroy());
		const unixHome = createServer((peer) => peer.destroy());
		try {
			mkdirSync(path.dirname(gitHead), { recursive: true });
			mkdirSync(secretDir, { recursive: true });
			writeFileSync(path.join(secretDir, "token"), "secret-token");
			writeFileSync(path.join(workspace, ".git"), marker);
			writeFileSync(gitHead, "fixture-HEAD");
			writeFileSync(sibling, "ordinary");
			writeFileSync(secret, "fixture-private");
			writeFileSync(reserved, "fixture-config");
			writeFileSync(shared, "initial");
			linkSync(shared, path.join(workspace, "shared"));
			symlinkSync(sibling, path.join(workspace, "sibling-ref"));

			host.listen(0, "127.0.0.1");
			await once(host, "listening");
			unixTmp.listen(hostTmpSocket);
			await once(unixTmp, "listening");
			unixHome.listen(maskedSocket);
			await once(unixHome, "listening");
			const address = host.address();
			if (!address || typeof address === "string")
				throw new Error("missing listener");

			const backend = new LinuxMxcBackend();
			const development: ShellProtection = {
				profile: "development",
				root: workspace,
				cwd: workspace,
				writeRoots: [workspace],
				readOnlyPaths: workspacePathProtection(workspace).readOnlyPaths,
				protectedPaths: [secret, secretDir, maskedSocket, reserved],
				stdin: "closed",
			};
			const investigation: ShellProtection = {
				...development,
				profile: "investigation",
				writeRoots: [],
			};

			// Absent .codelia cannot be pinned inside a writable workspace.
			const resolvedHelper = resolveMxcLauncher(investigation);
			const resolvedBwrap = resolveLinuxBwrap();
			expect(resolvedHelper).toBeDefined();
			expect(resolvedBwrap).toBeDefined();
			if (!resolvedHelper || !resolvedBwrap) {
				throw new Error("missing Linux MXC helper or bwrap");
			}
			expect(
				probeMxcLauncher(resolvedHelper, { bwrapPath: resolvedBwrap.file }),
			).toBe(true);
			expect(backend.supports(development)).toBe(false);
			expect(backend.supports(investigation)).toBe(true);
			mkdirSync(projectDirectory);
			writeFileSync(
				path.join(projectDirectory, "config.json"),
				"project configuration",
			);

			for (const policy of [investigation, development]) {
				expect(backend.supports(policy)).toBe(true);
				const child = backend.launch(
					{
						kind: "argv",
						executable: realpathSync(process.execPath),
						args: [
							"-e",
							linuxMxcFixtureScript,
							sibling,
							secret,
							secretDir,
							maskedSocket,
							hostTmpSocket,
							String(address.port),
						],
					},
					policy,
				);
				const result = await finish(child);
				await expect(mxcLifecycle(child)?.completed).resolves.toBe("clean");
				expect(JSON.parse(result.text)).toEqual({
					home: homedir(),
					sibling: "ordinary",
					protectedView: "",
					descendantView: "",
					protectedDirEntries: [],
					protectedWrite: false,
					protectedDirWrite: false,
					outsideWrite: false,
					insideWrite: policy === development,
					sharedWrite: policy === development,
					newExternalLink: false,
					externalSymlinkWrite: false,
					gitMarker: marker,
					gitHead: "fixture-HEAD",
					projectConfig: "project configuration",
					projectConfigWrite: false,
					moveProjectConfig: false,
					gitWrite: false,
					moveMetadata: false,
					reservedWrite: false,
					scratch: true,
					network: false,
					maskedHomeSocket: false,
					hostTmpIpc: false,
				});
			}

			expect(readFileSync(path.join(workspace, "result"), "utf8")).toBe(
				"development",
			);
			expect(readFileSync(shared, "utf8")).toBe("updated");
			expect(readFileSync(gitHead, "utf8")).toBe("fixture-HEAD");
			expect(readFileSync(secret, "utf8")).toBe("fixture-private");

			// A malicious `sh` in a workspace directory prepended to workload PATH
			// must NOT hijack MXC's `sh -c` wrapper, while workload PATH is preserved.
			const hijackBin = path.join(workspace, "hijack-bin");
			mkdirSync(hijackBin, { recursive: true });
			writeFileSync(
				path.join(hijackBin, "sh"),
				"#!/bin/sh\necho HIJACKED >&2\nexit 99\n",
				{ mode: 0o755 },
			);
			const pathPolicy: ShellProtection = {
				...investigation,
				binPaths: [hijackBin, "/usr/bin", "/bin"],
			};
			const safeRun = await finish(
				backend.launch(
					{
						kind: "argv",
						executable: realpathSync(process.execPath),
						args: ["-e", "process.stdout.write(process.env.PATH ?? '')"],
					},
					pathPolicy,
				),
			);
			expect(safeRun.text).toBe(`${hijackBin}:/usr/bin:/bin`);

			// Workload exit code 125 is reported as a clean confirmed completion.
			const exit125 = backend.launch(
				{ kind: "argv", executable: "/bin/sh", args: ["-c", "exit 125"] },
				investigation,
			);
			const closed125 = once(exit125, "close");
			exit125.stdout.resume();
			exit125.stderr.resume();
			await expect(mxcLifecycle(exit125)?.completed).resolves.toBe("clean");
			expect(await closed125).toEqual([125, null]);

			// Absent protectedPaths are refused without creating host placeholders.
			for (const policy of [investigation, development]) {
				const missing = {
					...policy,
					protectedPaths: [...policy.protectedPaths, incoming],
				};
				expect(backend.supports(missing)).toBe(false);
				expect(() =>
					backend.launch(
						{ kind: "argv", executable: "/usr/bin/true", args: [] },
						missing,
					),
				).toThrow("sandbox_unavailable");
				expect(lstatSync(incoming, { throwIfNoEntry: false })).toBeUndefined();
			}

			// Pipe stdin + cancellation cleans up descendants and confirms cleanup.
			const pipedProtection: ShellProtection = {
				...development,
				stdin: "pipe",
			};
			const code =
				"IFS= read -r line; printf '%s' \"$line\"; /bin/sleep 5 && printf leaked > leaked.txt";
			const pipedChild = backend.launch(fixedBash(code), pipedProtection);
			const firstChunk = once(pipedChild.stdout, "data");
			const task = startShellTask({
				taskId: "linux-mxc-stdin",
				command: code,
				cwd: workspace,
				stdinMode: "pipe",
				outputCache: {
					save: async () => {
						throw new Error("unexpected cache write");
					},
				},
				spawnProcess: () => pipedChild,
			});
			await task.writeInput?.({ text: "hello-mxc\n", close: true });
			expect(String((await firstChunk)[0])).toBe("hello-mxc");
			await task.cancel?.();
			await expect(task.wait).resolves.toMatchObject({
				state: "cancelled",
				result: { exit_code: 143 },
			});
			await expect(mxcLifecycle(pipedChild)?.completed).resolves.toBe("clean");

			// Truly detached descendant (stdio: ignore, detached: true, unref())
			// on normal parent exit, cancellation, and abrupt supervisor SIGKILL.
			const spawnDetached = `
				const fs = require("node:fs");
				const { spawn } = require("node:child_process");
				const [readyFile, leakedFile, stayAlive] = process.argv.slice(1);
				const child = spawn(
					process.execPath,
					["-e", "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], ''); setTimeout(() => fs.writeFileSync(process.argv[2], ''), 1800);", readyFile, leakedFile],
					{ detached: true, stdio: "ignore" }
				);
				child.unref();
				if (stayAlive === "stay") setInterval(() => {}, 1000);
			`;

			// 1) Normal workload exit with surviving detached descendant -> reaped & clean.
			const exitWorker = backend.launch(
				{
					kind: "argv",
					executable: realpathSync(process.execPath),
					args: [
						"-e",
						spawnDetached,
						"detached-exit-ready",
						"detached-exit-leaked",
						"exit",
					],
				},
				development,
			);
			await finish(exitWorker);
			await expect(mxcLifecycle(exitWorker)?.completed).resolves.toBe("clean");

			// 2) Cancellation with detached descendant -> reaped & clean.
			const cancelWorker = backend.launch(
				{
					kind: "argv",
					executable: realpathSync(process.execPath),
					args: [
						"-e",
						spawnDetached,
						"detached-cancel-ready",
						"detached-cancel-leaked",
						"stay",
					],
				},
				development,
			);
			const cancelClosed = once(cancelWorker, "close");
			try {
				const ready = Bun.file(path.join(workspace, "detached-cancel-ready"));
				const until = Date.now() + 10_000;
				while (!(await ready.exists()) && Date.now() < until)
					await Bun.sleep(25);
				expect(await ready.exists()).toBe(true);
			} finally {
				terminateChild(cancelWorker, "SIGTERM");
				await cancelClosed;
			}
			await expect(mxcLifecycle(cancelWorker)?.completed).resolves.toBe(
				"clean",
			);

			// 3) Abrupt supervisor crash (SIGKILL) -> unconfirmed AND descendant reaped.
			const crashWorker = backend.launch(
				{
					kind: "argv",
					executable: realpathSync(process.execPath),
					args: [
						"-e",
						spawnDetached,
						"detached-crash-ready",
						"detached-crash-leaked",
						"stay",
					],
				},
				development,
			);
			const crashClosed = once(crashWorker, "close");
			try {
				const ready = Bun.file(path.join(workspace, "detached-crash-ready"));
				const until = Date.now() + 10_000;
				while (!(await ready.exists()) && Date.now() < until)
					await Bun.sleep(25);
				expect(await ready.exists()).toBe(true);
			} finally {
				crashWorker.kill("SIGKILL");
				await crashClosed;
			}
			await expect(mxcLifecycle(crashWorker)?.completed).resolves.toBe(
				"unconfirmed",
			);

			await Bun.sleep(2200);
			expect(existsSync(path.join(workspace, "detached-exit-leaked"))).toBe(
				false,
			);
			expect(existsSync(path.join(workspace, "detached-cancel-leaked"))).toBe(
				false,
			);
			expect(existsSync(path.join(workspace, "detached-crash-leaked"))).toBe(
				false,
			);

			// Hard-link aliases to protected/read-only entries reject supports().
			const alias = path.join(workspace, "metadata-alias");
			linkSync(gitHead, alias);
			expect(backend.supports(development)).toBe(false);
			rmSync(alias);
			linkSync(secret, alias);
			expect(backend.supports(development)).toBe(false);
			expect(backend.supports(investigation)).toBe(false);
		} finally {
			host.close();
			unixTmp.close();
			unixHome.close();
			rmSync(directory, { recursive: true, force: true });
			rmSync(tmpSocketDir, { recursive: true, force: true });
		}
	}, 60_000);
});
