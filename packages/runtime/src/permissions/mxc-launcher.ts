import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { isHomeDotTarget } from "./home-dot-paths";
import type { ShellChild, ShellProtection } from "./shell-backend";

const binaryName = "codelia-mxc-launcher";
const packagePath = path.join("node_modules", "@codelia", "tui-darwin-arm64");
const moduleDir =
	typeof __dirname === "string"
		? __dirname
		: path.dirname(fileURLToPath(import.meta.url));

type TrustedLauncher = { file: string; identity: string };
type ResolvedLauncher = TrustedLauncher & { candidate: string };

const packageVersion = (
	directory: string,
	name: string,
): string | undefined => {
	try {
		const manifest = path.join(directory, "package.json");
		const info = lstatSync(manifest);
		if (!info.isFile() || info.size > 64 * 1024) return undefined;
		const parsed = JSON.parse(readFileSync(manifest, "utf8"));
		return parsed.name === name && typeof parsed.version === "string"
			? parsed.version
			: undefined;
	} catch {
		return undefined;
	}
};

const directoryId = (info: { dev: bigint; ino: bigint }) =>
	`${info.dev}:${info.ino}`;

const trustedLauncher = (
	candidate: string,
	writableDirs: ReadonlySet<string>,
	uid: bigint,
	protectedHome?: string,
): ResolvedLauncher | undefined => {
	try {
		const directory = realpathSync(path.dirname(candidate));
		const file = path.join(directory, binaryName);
		const info = lstatSync(file, { bigint: true });
		if (
			!info.isFile() ||
			info.nlink !== 1n ||
			info.size === 0n ||
			(info.uid !== uid && info.uid !== 0n) ||
			(info.mode & 0o6022n) !== 0n ||
			(info.mode & 0o100n) === 0n
		)
			return undefined;
		const protectedInHomeDot =
			protectedHome !== undefined && isHomeDotTarget(protectedHome, directory);
		let current = directory;
		for (;;) {
			const parent = statSync(current, { bigint: true });
			const systemSticky = parent.uid === 0n && (parent.mode & 0o1000n) !== 0n;
			const isWritableParent =
				writableDirs.has(directoryId(parent)) &&
				!(protectedInHomeDot && current === protectedHome);
			if (
				!parent.isDirectory() ||
				isWritableParent ||
				(parent.uid !== uid && parent.uid !== 0n) ||
				((parent.mode & 0o022n) !== 0n && !systemSticky)
			)
				return undefined;
			const next = path.dirname(current);
			if (next === current) break;
			current = next;
		}
		return {
			candidate,
			file,
			identity: `${directoryId(info)}:${info.size}:${info.ctimeNs}`,
		};
	} catch {
		return undefined;
	}
};

export const resolveMxcLauncher = (
	protection: ShellProtection,
): ResolvedLauncher | undefined => {
	const uid = process.geteuid?.();
	if (
		process.platform !== "darwin" ||
		process.arch !== "arm64" ||
		uid === undefined
	)
		return undefined;
	try {
		const mutable = new Set(
			[
				protection.root,
				...protection.writeRoots,
				...(protection.gitWriteRoots ?? []),
			].map((root) => directoryId(statSync(root, { bigint: true }))),
		);
		const actualModule = realpathSync(moduleDir);
		const projectPackage =
			path.basename(actualModule) === "permissions"
				? path.resolve(actualModule, "../..")
				: path.dirname(actualModule);
		const suffix = path.join("packages", "runtime");
		if (projectPackage.endsWith(`${path.sep}${suffix}`)) {
			const checkout = path.resolve(projectPackage, "../..");
			const built = trustedLauncher(
				path.join(checkout, "crates/mxc-launcher/target/release", binaryName),
				mutable,
				BigInt(uid),
			);
			if (built) return built;
		}
		// Resolve relative to the loaded runtime, like a normal dependency.
		// Project cwd, NODE_PATH and the command's PATH have no role here.
		const version = packageVersion(projectPackage, "@codelia/runtime");
		if (!version) return undefined;
		let directory = actualModule;
		for (;;) {
			const candidatePackage = path.join(directory, packagePath);
			const installed =
				packageVersion(candidatePackage, "@codelia/tui-darwin-arm64") ===
				version
					? trustedLauncher(
							path.join(candidatePackage, "bin", binaryName),
							mutable,
							BigInt(uid),
							protection.homeDotDirectory,
						)
					: undefined;
			if (installed) return installed;
			const parent = path.dirname(directory);
			if (parent === directory) return undefined;
			directory = parent;
		}
	} catch {
		return undefined;
	}
};

export const probeMxcLauncher = (launcher: TrustedLauncher): boolean =>
	spawnSync(launcher.file, ["--probe-v2"], {
		cwd: "/private/tmp",
		env: {},
		stdio: "ignore",
		timeout: 2500,
		killSignal: "SIGKILL",
	}).status === 0;

type LaunchRequest = {
	executable: string;
	args: string[];
	cwd: string;
	profile: string;
	scratch: string;
	path: string;
	home?: string;
	cargo_home?: string;
	rustup_home?: string;
};

type Completion = "clean" | "unconfirmed";
type Lifecycle = { revoke: () => void; completed: Promise<Completion> };
const lifecycles = new WeakMap<ChildProcess, Lifecycle>();

export const mxcLifecycle = (child: ChildProcess): Lifecycle | undefined =>
	lifecycles.get(child);

export const launchMxc = (
	launcher: TrustedLauncher,
	request: LaunchRequest,
	stdin: ShellProtection["stdin"],
): ShellChild => {
	const frame = `${JSON.stringify({ version: 2, ...request })}\n`;
	if (Buffer.byteLength(frame) > 256 * 1024)
		throw new Error("sandbox_launch_failed");
	const child = spawn(launcher.file, ["--run"], {
		cwd: "/private/tmp",
		env: {},
		detached: true,
		stdio: [stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe", "pipe"],
	}) as ShellChild;
	const control = child.stdio[3] as Duplex;
	let pending = "";
	let accepted = false;
	let failed = false;
	let expectedExit: number | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let reportCompletion: (result: Completion) => void;
	const completed = new Promise<Completion>((resolve) => {
		reportCompletion = resolve;
	});
	const boundCleanup = () => {
		deadline ??= setTimeout(() => {
			reportCompletion("unconfirmed");
			control.destroy();
			child.stdin?.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
		}, 8000);
	};
	const revoke = () => {
		if (!control.writableEnded && !control.destroyed) control.end();
		boundCleanup();
	};
	const rejectReport = () => {
		failed = true;
		revoke();
	};
	control.setEncoding("utf8");
	control.on("error", rejectReport);
	control.on("data", (chunk: string) => {
		if (failed) return;
		pending += chunk;
		if (pending.length > 256) return rejectReport();
		let newline = pending.indexOf("\n");
		while (newline !== -1) {
			try {
				const value = JSON.parse(pending.slice(0, newline));
				if (expectedExit !== undefined) return rejectReport();
				if (value.event === "started" && !accepted) accepted = true;
				else if (value.event === "cancelled") expectedExit = 143;
				else if (
					accepted &&
					value.event === "finished" &&
					Number.isInteger(value.exit_code) &&
					value.exit_code >= 0 &&
					value.exit_code <= 255
				)
					expectedExit = value.exit_code;
				else return rejectReport();
			} catch {
				return rejectReport();
			}
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
	});
	child.once("exit", boundCleanup);
	child.once("close", (code, signal) => {
		clearTimeout(deadline);
		reportCompletion(
			!failed && pending === "" && signal === null && code === expectedExit
				? "clean"
				: "unconfirmed",
		);
	});
	lifecycles.set(child, { revoke, completed });
	control.write(frame);
	return child;
};
