import { expect, test } from "bun:test";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { executableMountSnapshot } from "../src/permissions/linux-mountinfo";
import {
	checkLinuxMountTopology,
	LinuxRunscBackend,
} from "../src/permissions/linux-shell-backend";
import {
	MacSeatbeltBackend,
	platformShellSource,
	type ShellChild,
	type ShellProtection,
	UserShellBackend,
	workspacePathProtection,
} from "../src/permissions/shell-backend";

import { terminateChild } from "../src/tasks/shell-executor";

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

const cwd = process.cwd();
const base: ShellProtection = {
	profile: "investigation",
	root: cwd,
	cwd,
	writeRoots: [],
	protectedPaths: [],
	stdin: "closed",
};

test("only the explicitly selected login-user backend accepts full access and its command gets a controlled environment", async () => {
	const full = { ...base, profile: "full-access" as const };
	expect(new MacSeatbeltBackend().supports(full)).toBe(false);
	expect(new LinuxRunscBackend().supports(full)).toBe(false);
	const backend = new UserShellBackend();
	expect(backend.supports(base)).toBe(false);
	const child = backend.launch(
		{
			kind: "argv",
			executable: process.execPath,
			args: [
				"-e",
				"process.stdout.write(JSON.stringify({home: Boolean(process.env.HOME), env: Object.keys(process.env)}))",
			],
		},
		full,
	);
	const result = await finish(child);
	expect(result.code).toBe(0);
	const { env, home } = JSON.parse(result.text);
	expect(home).toBe(true);
	expect(env).not.toContain("BASH_ENV");
	expect(env).not.toContain("NODE_OPTIONS");
	expect(env).not.toContain("CODELIA_OS_TEST_SECRET");
	const source =
		process.platform === "win32"
			? "[Console]::Write('original source')"
			: "printf '%s' 'original source'";
	expect(
		await finish(backend.launch(platformShellSource(source), full)),
	).toEqual({ code: 0, text: "original source" });
});

test("ambiguous host mount aliases reject a Linux profile before launch", () => {
	const mounts = "1 0 8:1 / / rw - ext4 /dev/a rw\n";
	expect(() => checkLinuxMountTopology(mounts)).not.toThrow();
	expect(() =>
		checkLinuxMountTopology(
			`${mounts}2 1 8:1 /home /media/home rw - ext4 /dev/a rw\n`,
		),
	).toThrow("aliased_host_mount");
	expect(() =>
		checkLinuxMountTopology(`${mounts}3 1 0:3 / /altproc ro - proc proc rw\n`),
	).toThrow("unmediated_system_mount");
});

test("executable mount snapshots ignore unrelated binds and reject relevant aliases and stacks", () => {
	const root = "1 0 8:1 / / rw - ext4 /dev/a rw\n";
	const home = "2 1 0:274 / /home rw - btrfs /dev/b rw\n";
	const unrelated = "3 1 8:1 /opt /altopt rw - ext4 /dev/a rw\n";
	const alias = "4 2 0:274 /user /work/user rw - btrfs /dev/b rw\n";
	const overmount = "6 2 8:1 / /home/user rw - ext4 /dev/a rw\n";
	const peerAlias =
		"7 1 8:1 /home/user/bin/peer /work/peer rw - ext4 /dev/a rw\n";
	const file = "/home/user/bin/tool";
	const device = 0x100012n; // Linux dev_t for 0:274.
	const snapshot = (text: string) =>
		executableMountSnapshot(file, device, text);
	expect(snapshot(root + home + unrelated)).toBe(snapshot(root + home));
	expect(() => snapshot(root + home + alias)).toThrow("aliased_host_mount");
	expect(() => snapshot(root + home + home.replace("2 1", "5 2"))).toThrow(
		"unbound_executable_mount",
	);
	expect(() => snapshot(root + home + overmount)).toThrow(
		"unbound_executable_mount",
	);
	expect(() => snapshot(root)).toThrow("unbound_executable_mount");
	expect(snapshot(root.replace("1 0", "9 0") + home)).not.toBe(
		snapshot(root + home),
	);
	expect(executableMountSnapshot(file, 0x801n, root + unrelated)).toBe(
		executableMountSnapshot(file, 0x801n, root),
	);
	expect(() => executableMountSnapshot(file, 0x801n, root + peerAlias)).toThrow(
		"aliased_host_mount",
	);
});

test("an individual file mount in the executable directory cannot account for a hard link", () => {
	const root = "1 0 8:1 / / rw - ext4 /dev/a rw\n";
	const home = "2 1 0:42 /home /my\\040home rw - btrfs /dev/b rw\n";
	const peer =
		"3 2 0:42 /elsewhere/tool /my\\040home/bin/peer rw - btrfs /dev/b rw\n";
	expect(() =>
		executableMountSnapshot("/my home/bin/tool", 42n, root + home + peer),
	).toThrow("unbound_executable_mount");
});

const readWorkspaceFixture = `
const fs = require("node:fs");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const [sibling, secret, socket, port] = process.argv.slice(1);
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
  sibling: fs.readFileSync(sibling, "utf8"),
  protectedView: fs.readFileSync(secret, "utf8"),
  descendantView: spawnSync("/bin/cat", [secret], { encoding: "utf8" }).stdout,
  protectedWrite: allowed(() => fs.writeFileSync(secret, "changed")),
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
  ipc: await connects(socket),
};
process.stdout.write(JSON.stringify(result));
`;

test.skipIf(process.env.CODELIA_APPROVAL_LINUX_LIVE !== "1")(
	"rootless Linux worker enforces live workspace and Git scopes, private scratch, isolated network and cancellation",
	async () => {
		expect(process.platform).toBe("linux");
		const directory = await fs.mkdtemp(
			path.join(homedir(), "codelia-linux-fixture-"),
		);
		const workspace = path.join(directory, "work");
		const sibling = path.join(directory, "adjacent");
		const secret = path.join(directory, "private");
		const shared = path.join(directory, "existing-shared");
		const incoming = path.join(directory, "new-private");
		const reserved = path.join(workspace, ".env");
		const projectDirectory = path.join(workspace, ".codelia");
		const gitHead = path.join(workspace, "metadata/admin/HEAD");
		const marker = "gitdir: metadata/admin";
		const socket = path.join(directory, "service.sock");
		const host = createServer((peer) => peer.destroy());
		const unix = createServer((peer) => peer.destroy());
		try {
			await fs.mkdir(path.dirname(gitHead), { recursive: true });
			await fs.writeFile(path.join(workspace, ".git"), marker);
			await fs.writeFile(gitHead, "fixture-HEAD");
			await fs.writeFile(sibling, "ordinary");
			await fs.writeFile(secret, "fixture-private");
			await fs.writeFile(reserved, "fixture-config");
			await fs.writeFile(shared, "initial");
			await fs.link(shared, path.join(workspace, "shared"));
			await fs.symlink(sibling, path.join(workspace, "sibling-ref"));
			host.listen(0, "127.0.0.1");
			await once(host, "listening");
			unix.listen(socket);
			await once(unix, "listening");
			const address = host.address();
			if (!address || typeof address === "string")
				throw new Error("missing listener");
			const backend = new LinuxRunscBackend();
			const development: ShellProtection = {
				...base,
				readOnlyPaths: workspacePathProtection(workspace).readOnlyPaths,
				protectedPaths: [secret, reserved],
				root: workspace,
				cwd: workspace,
				profile: "development",
				writeRoots: [workspace],
			};
			const investigation: ShellProtection = {
				...development,
				profile: "investigation",
				writeRoots: [],
			};
			// A writable Linux view cannot pin an absent read-only directory.
			expect(backend.supports(development)).toBe(false);
			const absent = await finish(
				backend.launch(
					{
						kind: "argv",
						executable: process.execPath,
						args: [
							"-e",
							'try { require("node:fs").mkdirSync(".codelia"); process.stdout.write("created"); } catch { process.stdout.write("reserved"); }',
						],
					},
					investigation,
				),
			);
			expect(absent.text).toBe("reserved");
			await expect(fs.lstat(projectDirectory)).rejects.toMatchObject({
				code: "ENOENT",
			});
			await fs.mkdir(projectDirectory);
			await fs.writeFile(
				path.join(projectDirectory, "config.json"),
				"project configuration",
			);
			const initialEntries = (await fs.readdir(workspace)).sort();
			for (const policy of [investigation, development]) {
				expect(backend.supports(policy)).toBe(true);
				expect((await fs.readdir(workspace)).sort()).toEqual(initialEntries);
				const result = await finish(
					backend.launch(
						{
							kind: "argv",
							executable: process.execPath,
							args: [
								"-e",
								readWorkspaceFixture,
								sibling,
								secret,
								socket,
								String(address.port),
							],
						},
						policy,
					),
				);
				expect(JSON.parse(result.text)).toEqual({
					sibling: "ordinary",
					protectedView: "",
					descendantView: "",
					protectedWrite: false,
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
					ipc: false,
				});
			}
			expect(await fs.readFile(path.join(workspace, "result"), "utf8")).toBe(
				"development",
			);
			expect(await fs.readFile(shared, "utf8")).toBe("updated");
			expect(await fs.readFile(gitHead, "utf8")).toBe("fixture-HEAD");

			expect(await fs.readFile(secret, "utf8")).toBe("fixture-private");
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
				await expect(fs.lstat(incoming)).rejects.toMatchObject({
					code: "ENOENT",
				});
			}
			const sleeper = `
        const fs = require("node:fs");
        fs.writeFileSync("descendant-ready", "");
        setTimeout(() => fs.writeFileSync("descendant-finished", ""), 2000);
      `;
			const worker = backend.launch(
				{
					kind: "argv",
					executable: process.execPath,
					args: [
						"-e",
						'require("node:child_process").spawnSync(process.execPath, ["-e", process.argv[1]])',
						sleeper,
					],
				},
				development,
			);
			const closed = once(worker, "close");
			try {
				const ready = Bun.file(path.join(workspace, "descendant-ready"));
				const until = Date.now() + 10000;
				while (!(await ready.exists()) && Date.now() < until)
					await Bun.sleep(25);
				expect(await ready.exists()).toBe(true);
			} finally {
				terminateChild(worker, "SIGKILL");
				await closed;
			}
			await Bun.sleep(2200);
			expect(
				await Bun.file(path.join(workspace, "descendant-finished")).exists(),
			).toBe(false);

			const alias = path.join(workspace, "metadata-alias");
			await fs.link(gitHead, alias);
			expect(backend.supports(development)).toBe(false);
			await fs.unlink(alias);
			await fs.link(secret, alias);
			expect(backend.supports(development)).toBe(false);
			expect(backend.supports(investigation)).toBe(false);
		} finally {
			host.close();
			unix.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	60000,
);
