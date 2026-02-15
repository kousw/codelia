#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const PACKAGES_DIR = path.join(ROOT_DIR, "packages");
const TUI_CARGO_MANIFEST_PATH = path.join(ROOT_DIR, "crates", "tui", "Cargo.toml");
const SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

const [, , versionArg] = process.argv;

const usage = () => {
	console.error(
		"Usage: node scripts/bump-workspace-version.mjs <patch|minor|major|x.y.z>",
	);
};

const parseSemver = (value) => {
	const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
};

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

const bumpCargoManifestVersion = (manifestPath, nextVersion) => {
	const current = readFileSync(manifestPath, "utf8");
	const replaced = current.replace(
		/^version\s*=\s*"[^"]+"$/m,
		`version = "${nextVersion}"`,
	);
	if (replaced === current) {
		if (!/^version\s*=\s*"[^"]+"$/m.test(current)) {
			throw new Error(`No [package] version field found in ${manifestPath}`);
		}
		return false;
	}
	writeFileSync(manifestPath, replaced);
	return true;
};

const listPackageManifests = () => {
	const manifests = [];
	const walk = (dirPath) => {
		for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			const fullPath = path.join(dirPath, entry.name);
			const manifestPath = path.join(fullPath, "package.json");
			try {
				const pkg = readJson(manifestPath);
				if (pkg?.name && pkg?.version) {
					manifests.push(manifestPath);
					continue;
				}
			} catch {
				// ignore and recurse
			}
			walk(fullPath);
		}
	};
	walk(PACKAGES_DIR);
	return manifests;
};

const resolveTargetVersion = (arg, currentVersions) => {
	const explicit = parseSemver(arg);
	if (explicit) return arg;
	if (!["patch", "minor", "major"].includes(arg)) {
		usage();
		throw new Error(`Unsupported bump argument: ${arg}`);
	}
	if (currentVersions.size !== 1) {
		const versions = [...currentVersions].sort().join(", ");
		throw new Error(
			`Cannot use '${arg}' bump while workspace has multiple versions: ${versions}. Pass explicit x.y.z.`,
		);
	}
	const [current] = [...currentVersions];
	const parsed = parseSemver(current);
	if (!parsed) {
		throw new Error(`Current version is not simple semver x.y.z: ${current}`);
	}
	if (arg === "major") return `${parsed.major + 1}.0.0`;
	if (arg === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
	return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
};

const main = () => {
	if (!versionArg || versionArg === "-h" || versionArg === "--help") {
		usage();
		process.exit(versionArg ? 0 : 1);
	}

	const manifests = listPackageManifests();
	if (manifests.length === 0) {
		throw new Error("No package manifests found under packages/.");
	}

	const workspacePackages = new Map();
	const currentVersions = new Set();

	for (const manifestPath of manifests) {
		const pkg = readJson(manifestPath);
		if (!pkg.name || !pkg.version) continue;
		workspacePackages.set(pkg.name, manifestPath);
		currentVersions.add(pkg.version);
	}

	const nextVersion = resolveTargetVersion(versionArg, currentVersions);

	let changedCount = 0;
	const changedFiles = [];

	for (const manifestPath of manifests) {
		const pkg = readJson(manifestPath);
		let changed = false;

		if (pkg.version !== nextVersion) {
			pkg.version = nextVersion;
			changed = true;
		}

		for (const section of SECTIONS) {
			const deps = pkg[section];
			if (!deps || typeof deps !== "object") continue;
			for (const depName of Object.keys(deps)) {
				if (!workspacePackages.has(depName)) continue;
				if (deps[depName] === nextVersion) continue;
				deps[depName] = nextVersion;
				changed = true;
			}
		}

		if (!changed) continue;
		changedCount += 1;
		changedFiles.push(path.relative(ROOT_DIR, manifestPath));
		writeFileSync(manifestPath, `${JSON.stringify(pkg, null, "\t")}\n`);
	}

	if (bumpCargoManifestVersion(TUI_CARGO_MANIFEST_PATH, nextVersion)) {
		changedCount += 1;
		changedFiles.push(path.relative(ROOT_DIR, TUI_CARGO_MANIFEST_PATH));
	}

	if (changedCount === 0) {
		console.log(`All workspace packages are already at ${nextVersion}.`);
		return;
	}

	console.log(
		`Bumped workspace package versions to ${nextVersion} in ${changedCount} file(s).`,
	);
	for (const filePath of changedFiles.sort()) {
		console.log(`- ${filePath}`);
	}
};

try {
	main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to bump workspace version: ${message}`);
	process.exit(1);
}
