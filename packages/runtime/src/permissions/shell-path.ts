import {
	accessSync,
	type BigIntStats,
	constants,
	lstatSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { executableMountSnapshot } from "./linux-mountinfo";

export const shellBinPaths = (override?: string): readonly string[] =>
	Object.freeze((override ?? process.env.PATH ?? "").split(path.delimiter));

export const shellPathForLaunch = (binPaths?: readonly string[]): string =>
	(binPaths ?? shellBinPaths()).join(path.delimiter);

export const resolveShellExecutable = (
	name: string | undefined,
	paths: readonly string[],
	cwd = process.cwd(),
): string => {
	if (
		!name ||
		name.includes("\0") ||
		(!path.isAbsolute(name) &&
			(name.includes("/") ||
				(process.platform === "win32" && name.includes("\\"))))
	)
		throw new Error("invalid_executable");
	const executable =
		process.platform === "win32" && !path.extname(name) ? `${name}.exe` : name;
	const candidates = path.isAbsolute(executable)
		? [executable]
		: paths.map((entry) => {
				const directory =
					process.platform === "win32" &&
					entry.startsWith('"') &&
					entry.endsWith('"')
						? entry.slice(1, -1)
						: entry;
				const resolved = path.isAbsolute(directory)
					? directory
					: `${cwd}${path.sep}${directory || "."}`;
				return `${resolved}${path.sep}${executable}`;
			});
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			const actual = realpathSync(candidate);
			if (statSync(actual).isFile()) return actual;
		} catch {
			// Search the next PATH entry.
		}
	}
	throw new Error("executable_unavailable");
};

type CommandPathPolicy = (target: string) => "unbound" | "masked" | undefined;

// Check the original path and each symlink destination. Final realpath alone
// would miss a transit through a writable symlink outside the final directory.
const inspectBashPath = (candidate: string, policy: CommandPathPolicy) => {
	let current = "/";
	let components = candidate.split("/");
	let links = 0;
	let masked = false;
	while (components.length) {
		const component = components.shift();
		if (!component || component === ".") continue;
		const name = path.join(current, component);
		const restriction = policy(name);
		if (restriction === "unbound") throw new Error("unbound_shell_path");
		masked ||= restriction === "masked";
		const entry = lstatSync(name, { throwIfNoEntry: false });
		if (!entry) return undefined;
		if (!entry.isSymbolicLink()) {
			if (components.length && !entry.isDirectory()) return undefined;
			current = name;
			continue;
		}
		if (++links > 40) throw new Error("unbound_shell_path");
		const destination = readlinkSync(name);
		if (path.isAbsolute(destination)) current = "/";
		components = [...destination.split("/"), ...components];
	}
	return { file: current, masked };
};

export const bindBashCommand = (
	name: string,
	paths: readonly string[],
	policy: CommandPathPolicy,
	acceptShared: (file: string, info: BigIntStats) => boolean = () => false,
): { executable: string; lookupPath: string } | undefined => {
	const absolute = path.isAbsolute(name);
	try {
		for (const directory of absolute ? [""] : paths) {
			// A saved shell command cannot depend on its current directory or
			// on shell expansion of an entry from the launch environment.
			if (
				!absolute &&
				(!path.isAbsolute(directory) || directory.split("/").includes(".."))
			)
				return undefined;
			const inspected = inspectBashPath(
				absolute ? name : `${directory}/${name}`,
				policy,
			);
			if (!inspected) continue;
			const executable = realpathSync(inspected.file);
			const restriction = policy(executable);
			if (restriction === "unbound") return undefined;
			const info = statSync(executable, { bigint: true });
			if (!info.isFile()) continue;
			// An outside filename can still name a file writable through a
			// hard link in the workspace.
			if (info.nlink !== 1n && !acceptShared(executable, info))
				return undefined;
			try {
				accessSync(executable, constants.X_OK);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EACCES") continue;
				return undefined;
			}
			// A hidden ancestor cannot introduce an absent command. If an
			// executable is present, its visibility can change the search order.
			if (inspected.masked || restriction === "masked") return undefined;
			return {
				executable,
				lookupPath: absolute ? name : `${directory}/${name}`,
			};
		}
	} catch {
		return undefined;
	}
	return undefined;
};

export function bindKnownSystemExecutable(
	program: string,
	paths: readonly string[],
	policy: CommandPathPolicy,
	directArgv: boolean,
): string | undefined {
	if (process.platform === "win32") return undefined;
	const name = path.basename(program);
	const known = new Set(
		[`/usr/bin/${name}`, `/bin/${name}`].flatMap((entry) => {
			try {
				return [realpathSync(entry)];
			} catch {
				return [];
			}
		}),
	);
	if (!known.size) return undefined;
	const executable = bindBashCommand(
		program,
		paths,
		policy,
		(file, info) =>
			known.has(file) && isRootControlledSharedExecutable(file, info),
	)?.executable;
	return executable &&
		known.has(executable) &&
		(!directArgv || executable === program)
		? executable
		: undefined;
}

export const isRootControlledSharedExecutable = (
	file: string,
	info: BigIntStats,
): boolean => {
	const uid = process.getuid?.();
	return (
		uid !== undefined &&
		uid !== 0 &&
		uid === process.geteuid?.() &&
		info.uid === 0n &&
		(info.mode & 0o022n) === 0n &&
		notWritable(file)
	);
};

const sameLinkMetadata = (left: BigIntStats, right: BigIntStats): boolean =>
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.nlink === right.nlink &&
	left.mode === right.mode &&
	left.uid === right.uid &&
	left.gid === right.gid &&
	left.size === right.size &&
	left.mtimeNs === right.mtimeNs &&
	left.ctimeNs === right.ctimeNs;

export function areAllExecutableLinksOutsideRestrictedPaths(
	file: string,
	info: BigIntStats,
	policy: CommandPathPolicy,
): boolean {
	try {
		const parent = path.dirname(file);
		if (policy(parent) || realpathSync(parent) !== parent) return false;
		const directory = lstatSync(parent, { bigint: true });
		const executable = lstatSync(file, { bigint: true });
		if (
			!directory.isDirectory() ||
			!executable.isFile() ||
			!sameLinkMetadata(executable, info) ||
			executable.nlink < 2n
		)
			return false;

		// A file mount can add a name without consuming a hard link.
		const mounts =
			process.platform === "linux"
				? executableMountSnapshot(file, executable.dev)
				: undefined;
		// Each literal directory entry accounts for at most one link. A symlink
		// or a lossy filename decode must never stand in for another entry.
		let links = 0n;
		let foundExecutable = false;
		const entries = readdirSync(parent, { encoding: "buffer" });
		if (entries.length > 4096) return false;
		for (const entry of entries) {
			const name = entry.toString();
			if (!Buffer.from(name).equals(entry)) return false;
			const peer = path.join(parent, name);
			const peerInfo = lstatSync(peer, { bigint: true });
			if (peerInfo.dev !== executable.dev || peerInfo.ino !== executable.ino)
				continue;
			if (
				!peerInfo.isFile() ||
				policy(peer) ||
				!sameLinkMetadata(executable, peerInfo)
			)
				return false;
			foundExecutable ||= peer === file;
			links++;
		}

		return (
			foundExecutable &&
			links === executable.nlink &&
			realpathSync(parent) === parent &&
			sameLinkMetadata(directory, lstatSync(parent, { bigint: true })) &&
			sameLinkMetadata(executable, lstatSync(file, { bigint: true })) &&
			(mounts === undefined ||
				executableMountSnapshot(file, executable.dev) === mounts)
		);
	} catch {
		return false;
	}
}

const notWritable = (file: string): boolean => {
	try {
		accessSync(file, constants.W_OK);
		return false;
	} catch (error) {
		return ["EACCES", "EPERM", "EROFS"].includes(
			(error as NodeJS.ErrnoException).code ?? "",
		);
	}
};
