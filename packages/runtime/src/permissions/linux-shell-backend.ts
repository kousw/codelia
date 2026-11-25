import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isHomeDotTarget } from "./home-dot-paths";
import type { ExactLaunchCandidate, LaunchRuleCandidate } from "./launch-rules";
import { checkLinuxMountTopology } from "./linux-mountinfo";
import { findProtectedAliases, hasReadOnlyAliases } from "./protected-aliases";
import { resolveReservedTarget, resourceContainsPath } from "./resource-paths";
import { type ShellInvocation, shellInvocationArgs } from "./shell-analysis";
import type {
	ProtectedShellBackend,
	ShellChild,
	ShellProtection,
} from "./shell-backend";
import { shellPathForLaunch } from "./shell-path";

export { checkLinuxMountTopology } from "./linux-mountinfo";

const within = (root: string, name: string): boolean =>
	root === "/" || root === name || name.startsWith(`${root}/`);
const virtualRoots = ["/proc", "/dev", "/sys"];
const managedTool = (name: string): string => {
	const resolved = realpathSync(name);
	let current = resolved;
	for (;;) {
		const info = statSync(current);
		if (info.uid !== 0 || (info.mode & 0o022) !== 0)
			throw new Error("untrusted_sandbox_installation");
		if (current === resolved && (!info.isFile() || (info.mode & 0o111) === 0))
			throw new Error("sandbox_executable_unavailable");
		if (current === "/") return resolved;
		current = path.dirname(current);
	}
};

const masksFor = (policy: ShellProtection): string[] => {
	const paths = new Set<string>();
	for (const item of [...policy.protectedPaths, "/run"]) {
		if (!path.isAbsolute(item) || item !== path.normalize(item) || item === "/")
			throw new Error("invalid_protected_path");
		if (item === "/dev") continue; // gVisor always replaces the entire host device tree.
		let resolved: string;
		try {
			resolved = realpathSync(item);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// The canonical counterpart does not exist. Only an already masked
			// ancestor can protect it from becoming visible during a launch.
			resolved = item;
		}
		if (resolved === "/") throw new Error("invalid_protected_path");
		paths.add(item);
		paths.add(resolved);
	}
	const selected: string[] = [];
	for (const item of [...paths].sort((a, b) => a.length - b.length)) {
		if (!selected.some((mask) => within(mask, item))) selected.push(item);
	}
	return selected;
};

const readOnlyMount = (entry: string, projectedHome?: string): string => {
	try {
		if (realpathSync(entry) !== entry)
			throw new Error("unbound_read_only_path");
		return entry;
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "ENOENT" ||
			!projectedHome ||
			!within(projectedHome, entry) ||
			resolveReservedTarget(entry) !== entry
		)
			throw error;
	}
	// Mounting an absent target would leave a race with its creation. Under
	// the home projection we can keep the nearest real directory read-only.
	let parent = path.dirname(entry);
	while (within(projectedHome, parent)) {
		const info = lstatSync(parent, { throwIfNoEntry: false });
		if (info) {
			if (info.isDirectory() && realpathSync(parent) === parent) return parent;
			break;
		}
		if (parent === projectedHome) break;
		parent = path.dirname(parent);
	}
	throw new Error("unbound_read_only_path");
};

export const linuxRunscMountArgs = (
	policy: ShellProtection,
	state: string,
	masks: readonly string[],
): string[] => {
	const mountpoints = masks.map((target) => {
		const info = statSync(target, { throwIfNoEntry: false });
		// A synthetic mount can lose its association when the host creates
		// the missing entry. Refuse the policy before running the probe.
		if (!info) throw new Error("missing_protected_mountpoint");
		if (!info.isDirectory() && !info.isFile())
			throw new Error("unsupported_protected_mountpoint");
		return {
			target,
			placeholder: info.isDirectory() ? "empty-dir" : "empty-file",
		};
	});
	const readOnly = policy.readOnlyPaths ?? [];
	const home = policy.homeDotDirectory;
	const projectedHome =
		home && policy.writeRoots.includes(home) ? home : undefined;
	const protectedTargets = [...masks, ...readOnly];
	const covered = (target: string) =>
		protectedTargets.some((entry) => within(entry, target));
	const writableRoots = new Set<string>();
	const flags = ["--ro-bind", "/", "/", "--ro-bind", "/tmp", "/tmp"];
	for (const root of policy.writeRoots) {
		if (
			home &&
			root !== home &&
			(within(root, home) || resourceContainsPath(root, home))
		)
			throw new Error("unsupported_home_write_root");
		if (
			root === "/" ||
			realpathSync(root) !== root ||
			!statSync(root).isDirectory() ||
			virtualRoots.some((name) => within(name, root))
		)
			throw new Error("invalid_write_root");
		if (within(state, root)) continue;
		if (masks.some((mask) => within(mask, root)))
			throw new Error("invalid_write_root");
		if (readOnly.some((entry) => within(entry, root))) continue;
		if (root !== home) writableRoots.add(root);
	}
	if (projectedHome) {
		// Keep the directory itself read-only so absent dot entries cannot
		// be created. Expose only real, ordinary children as writable mounts.
		// Following a symlink then uses its target's existing mounts without
		// granting the target any authority from the symlink's name.
		if (projectedHome !== "/tmp")
			flags.push("--ro-bind", projectedHome, projectedHome);
		for (const name of readdirSync(projectedHome)) {
			const child = path.join(projectedHome, name);
			if (
				child === state ||
				isHomeDotTarget(projectedHome, child, "linux") ||
				covered(child)
			)
				continue;
			const info = lstatSync(child, { throwIfNoEntry: false });
			if (
				(info?.isDirectory() || info?.isFile()) &&
				realpathSync(child) === child
			)
				writableRoots.add(child);
		}
	}
	const readOnlyMounts = new Set<string>();
	const proposedRoots = [...writableRoots];
	for (const entry of [...readOnly].sort((a, b) => a.length - b.length)) {
		if (
			!masks.some((mask) => within(mask, entry)) &&
			proposedRoots.some((root) => within(root, entry)) &&
			![...readOnlyMounts].some((mount) => within(mount, entry))
		) {
			// A real enclosing read-only mount already reserves its descendant
			// names, including entries an unconfined process may create later.
			readOnlyMounts.add(readOnlyMount(entry, projectedHome));
		}
	}
	// A fallback can cover an entire child or a separately requested root.
	// Drop those writable binds before computing the ancestor mounts.
	protectedTargets.push(...readOnlyMounts);
	for (const root of writableRoots) {
		if (covered(root)) writableRoots.delete(root);
	}
	// A mutable ancestor must stay in place when the selected operand is a
	// nested mount. Mount that directory on itself to keep its entry pinned.
	const writeRoots = [...writableRoots];
	const anchors = new Set<string>();
	for (const entry of [...readOnlyMounts, ...masks]) {
		let parent = path.dirname(entry);
		while (writeRoots.some((root) => root !== parent && within(root, parent))) {
			if (!writableRoots.has(parent) && !covered(parent)) anchors.add(parent);
			parent = path.dirname(parent);
		}
	}
	for (const anchor of anchors) {
		const info = statSync(anchor, { throwIfNoEntry: false });
		if (!info) {
			anchors.delete(anchor);
			continue;
		}
		if (!info.isDirectory() || realpathSync(anchor) !== anchor)
			throw new Error("unbound_protected_ancestor");
	}
	for (const root of [...writeRoots, ...anchors].sort(
		(a, b) => a.length - b.length,
	))
		flags.push("--bind", root, root);
	for (const entry of [...readOnlyMounts].sort((a, b) => a.length - b.length)) {
		if (!writeRoots.some((root) => within(root, entry))) continue;
		flags.push("--ro-bind", entry, entry);
	}
	for (const { target, placeholder } of mountpoints)
		flags.push("--ro-bind", `${state}/${placeholder}`, target);
	flags.push("--tmpfs", state);
	return flags;
};

const prepare = (
	policy: ShellProtection,
	state: string,
	runsc: string,
	unshare: string,
): string[] => {
	if (
		policy.profile === "full-access" ||
		(policy.profile === "investigation" && policy.writeRoots.length) ||
		policy.gitWriteRoots?.length ||
		policy.gitProtectedPaths?.length
	)
		throw new Error("unsupported_protection");
	const masks = masksFor(policy);
	if (
		findProtectedAliases(policy.protectedAliasPaths ?? policy.protectedPaths)
			.size
	)
		throw new Error("protected_file_has_alias");
	const readOnly = policy.readOnlyPaths ?? [];
	if (
		policy.writeRoots.length &&
		hasReadOnlyAliases(policy.readOnlyAliasPaths ?? readOnly)
	)
		throw new Error("read_only_file_has_alias");
	checkLinuxMountTopology(readFileSync("/proc/self/mountinfo", "utf8"));
	return [
		"--pdeathsig",
		"KILL",
		"--",
		unshare,
		// The host PID namespace init dies with the util-linux supervisor. Killing
		// runsc alone can leave its Sentry and Gofer alive after cancellation.
		"--user",
		"--map-current-user",
		"--mount",
		"--pid",
		"--fork",
		"--kill-child=KILL",
		"--mount-proc",
		"--",
		runsc,
		`--root=${state}/runsc`,
		"--host-uds=none",
		"--host-fifo=none",
		"--network=none",
		"--overlay2=none",
		"bwrap",
		"--unshare-all",
		"--as-pid-1",
		"--cap-drop",
		"ALL",
		"--clearenv",
		...linuxRunscMountArgs(policy, state, masks),
		// The login home stays read-only outside existing grants; caches and
		// temporary files use the private state directory.
		"--setenv",
		"HOME",
		homedir(),
		"--setenv",
		"TMPDIR",
		state,
		"--setenv",
		"XDG_CACHE_HOME",
		state,
		"--setenv",
		"LANG",
		"C",
		"--setenv",
		"PATH",
		shellPathForLaunch(policy.binPaths),
		...Object.entries(policy.toolchainHomes ?? {}).flatMap(([name, value]) => [
			"--setenv",
			name,
			value,
		]),
		"--chdir",
		policy.cwd,
		"--",
	];
};

const release = (root: string): void =>
	rmSync(root, { recursive: true, force: true });

const allocate = (): string => {
	const root = mkdtempSync("/tmp/codelia-runsc-");
	try {
		mkdirSync(`${root}/runsc`, { mode: 0o700 });
		mkdirSync(`${root}/empty-dir`, { mode: 0o500 });
		writeFileSync(`${root}/empty-file`, "", { flag: "wx", mode: 0o400 });
		return root;
	} catch (error) {
		release(root);
		throw error;
	}
};

export class LinuxRunscBackend implements ProtectedShellBackend {
	readonly supportsReadOnlyPaths = true;
	readonly supportsHomeDotProtection = true;
	readonly supportsCommandBinding = true;
	private tools?: { setpriv: string; unshare: string; runsc: string };
	private readonly probed = new Set<string>();
	private resolveTools() {
		if (this.tools) return this.tools;
		let setpriv: string;
		try {
			setpriv = managedTool("/usr/bin/setpriv");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			setpriv = managedTool("/bin/setpriv");
		}
		const unshare = managedTool("/usr/bin/unshare");
		for (const candidate of ["/usr/local/bin/runsc", "/usr/bin/runsc"]) {
			try {
				const runsc = managedTool(candidate);
				const sidecars = path.join(path.dirname(runsc), "gvisor-bin");
				accessSync(path.join(sidecars, "gvisor_sentry"), constants.X_OK);
				for (const executable of readdirSync(sidecars)) {
					managedTool(path.join(sidecars, executable));
				}
				this.tools = { setpriv, unshare, runsc };
				return this.tools;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		throw new Error("runsc_not_installed");
	}
	supports(policy: ShellProtection): boolean {
		if (process.platform !== "linux" || process.getuid?.() === 0) return false;
		let state: string | undefined;
		try {
			const launcher = this.resolveTools();
			const key = JSON.stringify(policy);
			if (this.probed.has(key)) {
				prepare(
					policy,
					"/tmp/codelia-runsc-probe",
					launcher.runsc,
					launcher.unshare,
				);
				return true;
			}
			state = allocate();
			const args = prepare(policy, state, launcher.runsc, launcher.unshare);
			const probe = spawnSync(launcher.setpriv, [...args, "/usr/bin/true"], {
				env: { PATH: "/usr/bin:/bin" },
				stdio: "ignore",
				timeout: 8000,
				killSignal: "SIGKILL",
			});
			if (probe.status !== 0) return false;
			if (this.probed.size >= 16) this.probed.clear();
			this.probed.add(key);
			return true;
		} catch {
			return false;
		} finally {
			if (state) release(state);
		}
	}
	supportsLaunchBinding(candidate: LaunchRuleCandidate): boolean {
		return candidate.rule.template === "bun-typecheck/v1";
	}

	readonly exactLaunchBindingId = "codelia.linux.runsc/v2";

	supportsExactLaunchBinding(_candidate: ExactLaunchCandidate): boolean {
		return true;
	}
	launch(invocation: ShellInvocation, policy: ShellProtection): ShellChild {
		if (!this.supports(policy)) throw new Error("sandbox_unavailable");
		const state = allocate();
		const cleanup = () => release(state);
		try {
			const tools = this.resolveTools();
			const args = prepare(policy, state, tools.runsc, tools.unshare);
			const child = spawn(
				tools.setpriv,
				[...args, invocation.executable, ...shellInvocationArgs(invocation)],
				{
					cwd: policy.cwd,
					env: { PATH: "/usr/bin:/bin" },
					detached: true,
					stdio: [policy.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
				},
			) as ShellChild;
			child.once("close", cleanup);
			return child;
		} catch (error) {
			cleanup();
			throw error;
		}
	}
}
