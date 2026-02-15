#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const PACKAGES_DIR = path.join(ROOT_DIR, "packages");

const [, , versionArg, ...restArgs] = process.argv;
const noPush = restArgs.includes("--no-push");
const allowDirty = restArgs.includes("--allow-dirty");

const usage = () => {
	console.error(
		"Usage: node scripts/release-workspace.mjs <patch|minor|major|x.y.z> [--no-push] [--allow-dirty]",
	);
};

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		cwd: ROOT_DIR,
		stdio: "inherit",
		...options,
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}`);
	}
};

const runCapture = (command, args) => {
	const result = spawnSync(command, args, {
		cwd: ROOT_DIR,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const stderr = result.stderr ? result.stderr.trim() : "";
		throw new Error(
			`Command failed: ${command} ${args.join(" ")}${stderr ? `\n${stderr}` : ""}`,
		);
	}
	return result.stdout.trim();
};

const getWorkspaceVersion = () => {
	const cliManifestPath = path.join(PACKAGES_DIR, "cli", "package.json");
	const cliPackage = JSON.parse(readFileSync(cliManifestPath, "utf8"));
	if (!cliPackage.version || typeof cliPackage.version !== "string") {
		throw new Error(
			"Failed to detect workspace version from packages/cli/package.json.",
		);
	}
	return cliPackage.version;
};

const ensureCleanWorkingTree = () => {
	const status = runCapture("git", ["status", "--porcelain"]);
	if (!status) return;
	throw new Error(
		"Working tree is not clean. Commit/stash changes first, or rerun with --allow-dirty.",
	);
};

const main = () => {
	if (!versionArg || versionArg === "-h" || versionArg === "--help") {
		usage();
		process.exit(versionArg ? 0 : 1);
	}

	if (!allowDirty) {
		ensureCleanWorkingTree();
	}

	run("node", ["scripts/bump-workspace-version.mjs", versionArg]);
	run("bun", ["run", "check:versions"]);

	const changedFilesOutput = runCapture("git", [
		"diff",
		"--name-only",
		"--",
		"packages",
	]);
	const changedPackageManifests = changedFilesOutput
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith("/package.json"));

	if (changedPackageManifests.length === 0) {
		console.log("No package.json changes detected. Nothing to commit.");
		return;
	}

	run("git", ["add", "--", ...changedPackageManifests]);

	const nextVersion = getWorkspaceVersion();
	run("git", [
		"commit",
		"-m",
		`chore(release): bump workspace to v${nextVersion}`,
	]);

	if (noPush) {
		console.log(
			"Skipped push (--no-push). Release bump commit is ready locally.",
		);
		return;
	}

	run("git", ["push"]);
	console.log(`Release bump complete: v${nextVersion}`);
};

try {
	main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to run release workflow: ${message}`);
	process.exit(1);
}
