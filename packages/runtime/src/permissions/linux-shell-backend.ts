import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ExactLaunchCandidate, LaunchRuleCandidate } from "./launch-rules";
import { checkLinuxMountTopology } from "./linux-mountinfo";
import { findProtectedAliases, hasReadOnlyAliases } from "./protected-aliases";
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

const prepare = (
	policy: ShellProtection,
	state: string,
	runsc: string,
	unshare: string,
): string[] => {
	const masks = masksFor(policy);
	if (
		policy.profile === "full-access" ||
		(policy.profile === "investigation" && policy.writeRoots.length)
	)
		throw new Error("unsupported_protection");
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
	const flags = [
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
		"--ro-bind",
		"/",
		"/",
		"--ro-bind",
		"/tmp",
		"/tmp",
	];
	for (const root of policy.writeRoots) {
		if (
			root === "/" ||
			realpathSync(root) !== root ||
			!statSync(root).isDirectory() ||
			virtualRoots.some((name) => within(name, root)) ||
			readOnly.some((name) => within(name, root)) ||
			masks.some((mask) => within(mask, root))
		)
			throw new Error("invalid_write_root");
		flags.push("--bind", root, root);
	}
	// A mutable ancestor must stay in place when the selected operand is a
	// nested mount. Mount that directory on itself to keep its entry pinned.
	const anchors = new Set<string>();
	for (const entry of [...readOnly, ...masks]) {
		let parent = path.dirname(entry);
		while (
			policy.writeRoots.some((root) => root !== parent && within(root, parent))
		) {
			if (
				!masks.some((mask) => within(mask, parent)) &&
				!readOnly.some((ro) => within(ro, parent))
			)
				anchors.add(parent);
			parent = path.dirname(parent);
		}
	}
	for (const anchor of [...anchors].sort((a, b) => a.length - b.length)) {
		const info = statSync(anchor, { throwIfNoEntry: false });
		if (!info) continue;
		if (!info.isDirectory() || realpathSync(anchor) !== anchor)
			throw new Error("unbound_protected_ancestor");
		flags.push("--bind", anchor, anchor);
	}
	for (const entry of readOnly) {
		if (masks.some((mask) => within(mask, entry))) continue;
		if (!policy.writeRoots.some((root) => within(root, entry))) continue;
		if (realpathSync(entry) !== entry)
			throw new Error("unbound_read_only_path");
		flags.push("--ro-bind", entry, entry);
	}
	for (const { target, placeholder } of mountpoints)
		flags.push("--ro-bind", `${state}/${placeholder}`, target);
	flags.push(
		"--tmpfs",
		state,
		"--setenv",
		"HOME",
		state,
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
	);
	return flags;
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
