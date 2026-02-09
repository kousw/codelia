#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const PACKAGES_DIR = path.join(ROOT_DIR, "packages");
const SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

const CHECK_ONLY = process.argv.includes("--check");

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

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

const manifests = listPackageManifests();
const workspaceVersions = new Map();

for (const manifestPath of manifests) {
	const pkg = readJson(manifestPath);
	if (!pkg.name || !pkg.version) continue;
	workspaceVersions.set(pkg.name, pkg.version);
}

let changedCount = 0;
const changedFiles = [];

for (const manifestPath of manifests) {
	const pkg = readJson(manifestPath);
	let changed = false;

	for (const section of SECTIONS) {
		const deps = pkg[section];
		if (!deps || typeof deps !== "object") continue;

		for (const [depName, currentRange] of Object.entries(deps)) {
			const version = workspaceVersions.get(depName);
			if (!version) continue;
			if (currentRange === version) continue;
			deps[depName] = version;
			changed = true;
		}
	}

	if (!changed) continue;
	changedCount += 1;
	changedFiles.push(path.relative(ROOT_DIR, manifestPath));
	if (!CHECK_ONLY) {
		writeFileSync(manifestPath, `${JSON.stringify(pkg, null, "\t")}\n`);
	}
}

if (changedCount === 0) {
	console.log("Workspace dependency versions are synchronized.");
	process.exit(0);
}

if (CHECK_ONLY) {
	console.error("Workspace dependency versions are out of sync:");
	for (const filePath of changedFiles) {
		console.error(`- ${filePath}`);
	}
	process.exit(1);
}

console.log(
	`Synchronized workspace dependency versions in ${changedCount} file(s).`,
);
