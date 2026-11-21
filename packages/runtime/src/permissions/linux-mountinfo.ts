import { readFileSync } from "node:fs";
import path from "node:path";

const within = (root: string, name: string): boolean =>
	root === "/" || root === name || name.startsWith(`${root}/`);
const replacedSystemTrees = ["/proc", "/dev", "/sys"];

function parseMountInfo(text: string) {
	return text
		.trimEnd()
		.split("\n")
		.map((line) => {
			const fields = line.split(" ");
			const separator = fields.indexOf("-");
			const [, , device, root, target] = fields;
			const type = fields[separator + 1];
			if (
				separator < 6 ||
				!type ||
				!/^\d+:\d+$/.test(device) ||
				!root?.startsWith("/") ||
				!target?.startsWith("/")
			)
				throw new Error("unknown_mount_topology");
			return { device, root, target, type, line };
		});
}

// Refuse overlapping views of a filesystem; a pathname mask cannot hide a
// separate bind alias.
function checkMountViews(mounts: ReturnType<typeof parseMountInfo>): void {
	const views = new Map<string, string[]>();
	for (const { device, root, type } of mounts) {
		if (
			[
				"proc",
				"sysfs",
				"cgroup",
				"cgroup2",
				"devtmpfs",
				"devpts",
				"mqueue",
				"debugfs",
				"securityfs",
				"tracefs",
				"bpf",
				"configfs",
				"autofs",
			].includes(type)
		)
			throw new Error("unmediated_system_mount");
		const roots = views.get(device) ?? [];
		if (roots.some((other) => within(other, root) || within(root, other)))
			throw new Error("aliased_host_mount");
		roots.push(root);
		views.set(device, roots);
	}
}

export function checkLinuxMountTopology(text: string): void {
	checkMountViews(
		parseMountInfo(text).filter(
			({ target }) => !replacedSystemTrees.some((root) => within(root, target)),
		),
	);
}

export function executableMountSnapshot(
	file: string,
	dev: bigint,
	text = readFileSync("/proc/self/mountinfo", "utf8"),
): string {
	// Linux dev_t represents major and minor numbers in split bit fields.
	const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
	const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
	const device = `${major}:${minor}`;
	// Compare paths in mountinfo's escaped representation.
	const executable = file.replace(
		/[ \t\n\\]/g,
		(char) => `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`,
	);
	const parent = path.posix.dirname(executable);
	const mounts = parseMountInfo(text);
	const ancestors = mounts
		.filter(({ target }) => within(target, parent))
		.sort((left, right) => right.target.length - left.target.length);
	const [selected] = ancestors;
	if (
		!selected ||
		selected.device !== device ||
		ancestors.some(
			(mount, index) => mount.target === ancestors[index + 1]?.target,
		)
	)
		throw new Error("unbound_executable_mount");
	checkMountViews([selected]);
	// Translate the installation directory into its path inside the filesystem
	// so we can distinguish a bind of that directory from an unrelated bind.
	const installed = path.posix.join(
		selected.root,
		path.posix.relative(selected.target, parent),
	);
	const directChild = (directory: string, entry: string) =>
		entry !== directory && path.posix.dirname(entry) === directory;
	const directMounts = mounts.filter(({ target }) =>
		directChild(parent, target),
	);
	if (directMounts.some((mount) => mount.device === device))
		throw new Error("unbound_executable_mount");
	if (
		mounts.some(
			(mount) =>
				mount !== selected &&
				mount.device === device &&
				(within(mount.root, installed) || directChild(installed, mount.root)),
		)
	)
		throw new Error("aliased_host_mount");
	return mounts
		.filter(
			({ target }) => within(target, parent) || directChild(parent, target),
		)
		.map(({ line }) => line)
		.join("\n");
}
