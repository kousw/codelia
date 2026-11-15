import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

const listPackageDirs = () => {
	const workspaces = readJson(path.join(ROOT_DIR, "package.json")).workspaces;
	const patterns = Array.isArray(workspaces)
		? workspaces
		: workspaces?.packages;
	if (!Array.isArray(patterns))
		throw new Error("package.json workspaces must be an array");
	const dirs = new Set();
	for (const pattern of patterns) {
		if (
			typeof pattern !== "string" ||
			pattern.startsWith("!") ||
			path.isAbsolute(pattern) ||
			pattern.includes("**") ||
			/[[\]{}]/.test(pattern)
		) {
			throw new Error(`unsupported workspace pattern: ${String(pattern)}`);
		}
		let candidates = [ROOT_DIR];
		for (const part of pattern
			.split("/")
			.filter((value) => value && value !== ".")) {
			if (part === "..") throw new Error(`workspace escapes root: ${pattern}`);
			const expression = new RegExp(
				`^${part
					.replace(/[.+^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, ".*")
					.replace(/\?/g, ".")}$`,
			);
			candidates = candidates.flatMap((parent) => {
				try {
					return readdirSync(parent, { withFileTypes: true })
						.filter(
							(entry) =>
								entry.isDirectory() &&
								entry.name !== "node_modules" &&
								expression.test(entry.name),
						)
						.map((entry) => path.join(parent, entry.name));
				} catch (error) {
					if (error.code === "ENOENT") return [];
					throw error;
				}
			});
		}
		for (const dir of candidates) {
			try {
				if (statSync(path.join(dir, "package.json")).isFile()) dirs.add(dir);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
	return [...dirs];
};

const collectSourceFiles = (baseDir) => {
	const roots = ["src", "tests", "scripts"]
		.map((name) => path.join(baseDir, name))
		.filter((dirPath) => {
			try {
				return statSync(dirPath).isDirectory();
			} catch {
				return false;
			}
		});
	const files = [];
	const walk = (dirPath) => {
		for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
			const fullPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(fullPath)) {
				continue;
			}
			files.push(fullPath);
		}
	};
	for (const root of roots) walk(root);
	return files;
};

const extractSpecifiers = (source) => {
	const specs = new Set();
	const patterns = [
		/from\s+["']([^"']+)["']/g,
		/import\s+["']([^"']+)["']/g,
		/import\s*\(\s*["']([^"']+)["']\s*\)/g,
		/require\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\.resolve\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			const spec = match[1];
			if (spec) specs.add(spec);
		}
	}
	return [...specs];
};

const getWorkspacePackageName = (specifier) => {
	if (!specifier.startsWith("@codelia/")) return null;
	const parts = specifier.split("/");
	if (parts.length < 2) return null;
	return `${parts[0]}/${parts[1]}`;
};

const isDeepImport = (specifier, packageName, targetPackage) => {
	if (!specifier.startsWith(`${packageName}/`)) return false;
	const subpath = `.${specifier.slice(packageName.length)}`;
	const exports = targetPackage.exports;
	if (!exports || typeof exports !== "object" || Array.isArray(exports))
		return true;
	if (Object.hasOwn(exports, subpath)) return exports[subpath] === null;
	return !Object.keys(exports).some((key) => {
		if (!key.startsWith("./") || !key.includes("*") || exports[key] === null)
			return false;
		const [prefix, suffix] = key.split("*");
		return (
			subpath.startsWith(prefix) &&
			subpath.endsWith(suffix) &&
			subpath.length >= prefix.length + suffix.length
		);
	});
};

const packageDirs = listPackageDirs();
const packageInfo = packageDirs.map((dirPath) => {
	const pkg = readJson(path.join(dirPath, "package.json"));
	return { dirPath, pkg };
});

const workspacePackages = new Set(packageInfo.map(({ pkg }) => pkg.name));
const packagesByName = new Map(packageInfo.map(({ pkg }) => [pkg.name, pkg]));
const failures = [];

for (const { dirPath, pkg } of packageInfo) {
	const packageName = pkg.name;
	const declared = new Set(
		[
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.devDependencies ?? {}),
			...Object.keys(pkg.peerDependencies ?? {}),
		].filter((name) => workspacePackages.has(name)),
	);
	const used = new Set();
	const deepImportViolations = [];
	const files = collectSourceFiles(dirPath);

	for (const filePath of files) {
		const source = readFileSync(filePath, "utf8");
		for (const specifier of extractSpecifiers(source)) {
			const targetPackage = getWorkspacePackageName(specifier);
			if (!targetPackage || !workspacePackages.has(targetPackage)) continue;
			if (targetPackage !== packageName) {
				used.add(targetPackage);
				if (
					isDeepImport(
						specifier,
						targetPackage,
						packagesByName.get(targetPackage),
					)
				) {
					deepImportViolations.push({
						filePath,
						specifier,
					});
				}
			}
		}
	}

	const unusedDeclared = [...declared].filter((name) => !used.has(name));
	const undeclaredUsed = [...used].filter((name) => !declared.has(name));

	if (
		unusedDeclared.length === 0 &&
		undeclaredUsed.length === 0 &&
		deepImportViolations.length === 0
	) {
		continue;
	}

	failures.push({
		packageName,
		unusedDeclared,
		undeclaredUsed,
		deepImportViolations,
	});
}

if (failures.length > 0) {
	console.error("Workspace dependency hygiene check failed:");
	for (const failure of failures) {
		console.error(`\n- ${failure.packageName}`);
		if (failure.unusedDeclared.length > 0) {
			console.error(
				`  unused declared workspace deps: ${failure.unusedDeclared.join(", ")}`,
			);
		}
		if (failure.undeclaredUsed.length > 0) {
			console.error(
				`  missing workspace deps in package.json: ${failure.undeclaredUsed.join(", ")}`,
			);
		}
		if (failure.deepImportViolations.length > 0) {
			console.error("  deep imports across package boundary:");
			for (const violation of failure.deepImportViolations) {
				const relativePath = path.relative(ROOT_DIR, violation.filePath);
				console.error(`    ${relativePath}: ${violation.specifier}`);
			}
		}
	}
	process.exit(1);
}

console.log("Workspace dependency hygiene check passed.");
