import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resourceContainsPath } from "./resource-paths";

const runtimeModuleDirectory =
	typeof __dirname === "string"
		? __dirname
		: path.dirname(fileURLToPath(import.meta.url));

const isInstalledCodeliaPackage = (directory: string, name: string): boolean =>
	path.basename(directory) === name &&
	path.basename(path.dirname(directory)) === "@codelia" &&
	path.basename(path.dirname(path.dirname(directory))) === "node_modules";

const installedRuntime = (location: string): string | undefined => {
	for (
		let entry = realpathSync(location);
		entry !== path.dirname(entry);
		entry = path.dirname(entry)
	) {
		if (isInstalledCodeliaPackage(entry, "runtime")) return entry;
	}
	return undefined;
};

const dependencyInstallRoot = (directory: string): string => {
	let outerModules = directory;
	for (
		let entry = directory;
		entry !== path.dirname(entry);
		entry = path.dirname(entry)
	) {
		// The nested global npm install owns its dependencies under the CLI package.
		if (isInstalledCodeliaPackage(entry, "cli")) return entry;
		if (path.basename(entry) === "node_modules") outerModules = entry;
	}
	return outerModules;
};

/** Resolve release code from the loaded runtime, independent of the workspace and shell PATH. */
export const localShellInstallPaths = (
	moduleDirectory = runtimeModuleDirectory,
): readonly string[] => {
	const runtime = installedRuntime(moduleDirectory);
	if (!runtime) return [];
	const reserved = new Set([dependencyInstallRoot(runtime)]);
	const manifest = path.join(runtime, "package.json");
	const dependencies: Record<string, unknown> =
		JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {};
	const require = createRequire(manifest);
	const platform = `@codelia/tui-${process.platform}-${process.arch}`;
	for (const name of [...Object.keys(dependencies), "@codelia/cli", platform]) {
		for (const modules of require.resolve.paths(name) ?? []) {
			const entry = path.join(modules, name);
			if (!existsSync(path.join(entry, "package.json"))) continue;
			const actual = realpathSync(entry);
			reserved.add(dependencyInstallRoot(actual));
			if (entry !== actual) reserved.add(entry);
			break;
		}
	}
	return [...reserved];
};

export const protectsAdditionalWritePaths = (
	requestedRoots: readonly string[],
	reservedPaths: readonly string[],
): boolean =>
	!requestedRoots.some((root) =>
		reservedPaths.some(
			(entry) =>
				resourceContainsPath(root, entry) || resourceContainsPath(entry, root),
		),
	);
