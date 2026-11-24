import {
	accessSync,
	constants,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isHomeDotTarget } from "./home-dot-paths";
import type { ExactLaunchCandidate, LaunchRuleCandidate } from "./launch-rules";
import { checkLinuxMountTopology } from "./linux-mountinfo";
import {
	launchMxc,
	type MxcFilesystemSpec,
	probeMxcLauncher,
	resolveMxcLauncher,
} from "./mxc-launcher";
import { findProtectedAliases, hasReadOnlyAliases } from "./protected-aliases";
import { resolveReservedTarget, resourceContainsPath } from "./resource-paths";
import { type ShellInvocation, shellInvocationArgs } from "./shell-analysis";
import type {
	ProtectedShellBackend,
	ShellChild,
	ShellProtection,
} from "./shell-backend";
import { shellPathForLaunch } from "./shell-path";

const within = (root: string, name: string): boolean =>
	root === "/" || root === name || name.startsWith(`${root}/`);

const virtualRoots = ["/proc", "/dev", "/sys", "/run", "/var/run"];

/**
 * Bubblewrap's baseline read-only paths mounted by MXC 1.1.0 before policy
 * mounts. Kept in sync with `mxc-sdk` `BASELINE_RO_BIND_PATHS`.
 */
const baselineReadOnlyRoots = [
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/libx32",
	"/usr/bin",
	"/usr/sbin",
	"/usr/lib",
	"/usr/lib32",
	"/usr/lib64",
	"/usr/libx32",
	"/usr/libexec",
	"/usr/share",
	"/etc",
];

/**
 * Broad read-only directories exposed on Linux MXC so ordinary developer tools,
 * home files, and local packages remain readable while `/`, `/run`, `/var/run`,
 * `/dev`, `/proc`, `/sys`, and host `/tmp` stay isolated.
 */
export const DEFAULT_LINUX_MXC_READABLE_ROOTS: readonly string[] = [
	"/home",
	"/opt",
	"/srv",
	"/mnt",
	"/media",
	"/nix",
	"/usr/local",
	"/usr/include",
	"/var/cache",
	"/var/lib",
];

const disallowedExtraReadRoots = new Set(["/", "/tmp", ...virtualRoots]);

const deniedPathsFor = (policy: ShellProtection): string[] => {
	const paths = new Set<string>();
	for (const item of policy.protectedPaths) {
		if (!path.isAbsolute(item) || item !== path.normalize(item) || item === "/")
			throw new Error("invalid_protected_path");
		// Bubblewrap always replaces `/dev` with a minimal private device tree.
		if (item === "/dev") continue;
		let resolved: string;
		try {
			resolved = realpathSync(item);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
	for (const target of selected) {
		const info = statSync(target, { throwIfNoEntry: false });
		// MXC 1.1.0 creates host placeholders for absent denied paths inside
		// writable trees and needs bwrap >= 0.11 overlays under read-only trees.
		// Require concrete protected entries before admitting the launch.
		if (!info) throw new Error("missing_protected_mountpoint");
		if (!info.isDirectory() && !info.isFile())
			throw new Error("unsupported_protected_mountpoint");
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

const existingReadableDirectory = (
	candidate: string,
	requireCanonical = false,
): string | undefined => {
	if (!path.isAbsolute(candidate)) return undefined;
	try {
		const linfo = lstatSync(candidate, { throwIfNoEntry: false });
		if (!linfo) return undefined;
		if (requireCanonical && linfo.isSymbolicLink()) return undefined;
		const resolved = realpathSync(candidate);
		if (requireCanonical && resolved !== candidate) return undefined;
		const info = statSync(resolved, { throwIfNoEntry: false });
		if (!info?.isDirectory()) return undefined;
		accessSync(resolved, constants.R_OK);
		return resolved;
	} catch {
		return undefined;
	}
};

export const buildLinuxMxcFilesystemPolicy = (
	policy: ShellProtection,
	scratch: string,
	options: {
		readableRoots?: readonly string[];
		skipScratchStat?: boolean;
		homeDir?: string;
	} = {},
): MxcFilesystemSpec => {
	if (
		policy.profile === "full-access" ||
		(policy.profile === "investigation" && policy.writeRoots.length) ||
		policy.gitWriteRoots?.length ||
		policy.gitProtectedPaths?.length
	)
		throw new Error("unsupported_protection");
	if (
		!path.isAbsolute(scratch) ||
		scratch !== path.normalize(scratch) ||
		scratch === "/" ||
		virtualRoots.some((name) => within(name, scratch))
	)
		throw new Error("invalid_scratch_root");
	if (
		!options.skipScratchStat &&
		(realpathSync(scratch) !== scratch || !statSync(scratch).isDirectory())
	)
		throw new Error("invalid_scratch_root");

	const deniedPaths = deniedPathsFor(policy);
	if (deniedPaths.some((mask) => within(mask, scratch)))
		throw new Error("invalid_scratch_root");

	const readOnly = policy.readOnlyPaths ?? [];
	const home = policy.homeDotDirectory;
	const projectedHome =
		home && policy.writeRoots.includes(home) ? home : undefined;
	const protectedTargets = [...deniedPaths, ...readOnly];
	const covered = (target: string) =>
		protectedTargets.some((entry) => within(entry, target));

	const writableRoots = new Set<string>();
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
		if (within(scratch, root)) continue;
		if (deniedPaths.some((mask) => within(mask, root)))
			throw new Error("invalid_write_root");
		if (readOnly.some((entry) => within(entry, root))) continue;
		if (root !== home) writableRoots.add(root);
	}

	const explicitReadOnly = new Set<string>();
	if (projectedHome) {
		// Keep the home directory itself read-only so absent dot entries cannot
		// be created. Expose only real, ordinary children as writable mounts.
		explicitReadOnly.add(projectedHome);
		for (const name of readdirSync(projectedHome)) {
			const child = path.join(projectedHome, name);
			if (
				child === scratch ||
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
			!deniedPaths.some((mask) => within(mask, entry)) &&
			proposedRoots.some((root) => within(root, entry)) &&
			![...readOnlyMounts].some((mount) => within(mount, entry))
		) {
			readOnlyMounts.add(readOnlyMount(entry, projectedHome));
		}
	}
	protectedTargets.push(...readOnlyMounts);
	for (const root of writableRoots) {
		if (covered(root)) writableRoots.delete(root);
	}

	// Keep mutable ancestors of nested read-only or denied mounts pinned as
	// their own bind mounts so renaming an ancestor fails with EBUSY.
	const writeRoots = [...writableRoots];
	const anchors = new Set<string>();
	for (const entry of [...readOnlyMounts, ...deniedPaths]) {
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

	const readwritePaths = [
		...new Set([scratch, ...writeRoots, ...anchors]),
	].sort((a, b) => a.length - b.length || a.localeCompare(b));

	const readOnlyPaths = new Set<string>();
	for (const dir of options.readableRoots ?? DEFAULT_LINUX_MXC_READABLE_ROOTS) {
		const canonical = existingReadableDirectory(dir, true);
		if (!canonical) continue;
		if (
			disallowedExtraReadRoots.has(canonical) ||
			virtualRoots.some((name) => within(name, canonical)) ||
			deniedPaths.some((mask) => within(mask, canonical)) ||
			readwritePaths.some((rw) => within(rw, canonical))
		)
			continue;
		readOnlyPaths.add(canonical);
	}
	for (const entry of explicitReadOnly) {
		if (!deniedPaths.some((mask) => within(mask, entry))) {
			readOnlyPaths.add(entry);
		}
	}
	for (const entry of readOnlyMounts) {
		if (writeRoots.some((root) => within(root, entry))) {
			readOnlyPaths.add(entry);
		}
	}

	const extraReadableCandidates: string[] = [
		policy.root,
		policy.cwd,
		options.homeDir ?? homedir(),
		...Object.values(policy.toolchainHomes ?? {}).filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		),
		...(policy.binPaths ?? []),
	];
	for (const candidate of extraReadableCandidates) {
		const canonical = existingReadableDirectory(candidate, false);
		if (!canonical) continue;
		if (
			disallowedExtraReadRoots.has(canonical) ||
			virtualRoots.some((name) => within(name, canonical)) ||
			baselineReadOnlyRoots.some((base) => within(base, canonical)) ||
			deniedPaths.some((mask) => within(mask, canonical)) ||
			readwritePaths.some((rw) => within(rw, canonical)) ||
			[...readOnlyPaths].some((ro) => within(ro, canonical))
		)
			continue;
		readOnlyPaths.add(canonical);
	}

	return {
		readwrite_paths: readwritePaths,
		readonly_paths: [...readOnlyPaths].sort(
			(a, b) => a.length - b.length || a.localeCompare(b),
		),
		denied_paths: [...deniedPaths].sort(
			(a, b) => a.length - b.length || a.localeCompare(b),
		),
	};
};

const release = (root: string): void => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Only this launch's private directory is eligible for cleanup.
	}
};

export class LinuxMxcBackend implements ProtectedShellBackend {
	readonly supportsReadOnlyPaths = true;
	readonly supportsHomeDotProtection = true;
	readonly supportsCommandBinding = true;
	readonly exactLaunchBindingId = "codelia.linux.mxc/v1";
	private mxcProbe?: { identity: string; available: boolean };

	private validatePolicy(
		policy: ShellProtection,
		scratch: string,
		skipScratchStat: boolean,
	): MxcFilesystemSpec {
		const spec = buildLinuxMxcFilesystemPolicy(policy, scratch, {
			skipScratchStat,
		});
		if (
			findProtectedAliases(policy.protectedAliasPaths ?? policy.protectedPaths)
				.size > 0
		)
			throw new Error("protected_file_has_alias");
		const readOnly = policy.readOnlyPaths ?? [];
		if (
			policy.writeRoots.length &&
			hasReadOnlyAliases(policy.readOnlyAliasPaths ?? readOnly)
		)
			throw new Error("read_only_file_has_alias");
		checkLinuxMountTopology(readFileSync("/proc/self/mountinfo", "utf8"));
		return spec;
	}

	supports(policy: ShellProtection): boolean {
		if (process.platform !== "linux" || process.getuid?.() === 0) return false;
		try {
			this.validatePolicy(policy, "/tmp/codelia-mxc-probe", true);
			const helper = resolveMxcLauncher(policy);
			if (!helper) return false;
			if (helper.identity !== this.mxcProbe?.identity) {
				this.mxcProbe = {
					identity: helper.identity,
					available: probeMxcLauncher(helper),
				};
			}
			return this.mxcProbe.available;
		} catch {
			return false;
		}
	}

	supportsLaunchBinding(candidate: LaunchRuleCandidate): boolean {
		return candidate.rule.template === "bun-typecheck/v1";
	}

	supportsExactLaunchBinding(_candidate: ExactLaunchCandidate): boolean {
		return true;
	}

	launch(invocation: ShellInvocation, policy: ShellProtection): ShellChild {
		if (!this.supports(policy)) throw new Error("sandbox_unavailable");
		const scratch = realpathSync(mkdtempSync("/tmp/codelia-mxc-"));
		const cleanup = () => release(scratch);
		try {
			const filesystem = this.validatePolicy(policy, scratch, false);
			const helper = resolveMxcLauncher(policy);
			if (!helper || helper.identity !== this.mxcProbe?.identity)
				throw new Error("sandbox_unavailable");
			const child = launchMxc(
				helper,
				{
					executable: invocation.executable,
					args: shellInvocationArgs(invocation),
					cwd: policy.cwd,
					filesystem,
					scratch,
					path: shellPathForLaunch(policy.binPaths),
					home: homedir(),
					cargo_home: policy.toolchainHomes?.CARGO_HOME,
					rustup_home: policy.toolchainHomes?.RUSTUP_HOME,
				},
				policy.stdin,
			);
			child.once("close", cleanup);
			return child;
		} catch (error) {
			cleanup();
			throw error;
		}
	}
}
