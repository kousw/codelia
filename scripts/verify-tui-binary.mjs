#!/usr/bin/env node

import fsSync from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const TARGETS = {
	"darwin-arm64": {
		packageDir: "packages/tui/darwin-arm64",
		binaryName: "codelia-tui",
	},
	"darwin-x64": {
		packageDir: "packages/tui/darwin-x64",
		binaryName: "codelia-tui",
	},
	"linux-arm64": {
		packageDir: "packages/tui/linux-arm64",
		binaryName: "codelia-tui",
	},
	"linux-x64": {
		packageDir: "packages/tui/linux-x64",
		binaryName: "codelia-tui",
	},
	"win32-x64": {
		packageDir: "packages/tui/win32-x64",
		binaryName: "codelia-tui.exe",
	},
};

const parseTarget = () => {
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === "--target") {
			return args[i + 1] ?? "";
		}
	}
	return "";
};

const main = async () => {
	const target = parseTarget();
	if (!target || !TARGETS[target]) {
		throw new Error(
			`Missing or unsupported --target value. Supported: ${Object.keys(TARGETS).join(", ")}`,
		);
	}

	const { packageDir, binaryName } = TARGETS[target];
	const binaryPath = path.resolve(rootDir, packageDir, "bin", binaryName);
	await access(binaryPath, fsSync.constants.R_OK);
	const info = await stat(binaryPath);
	if (!info.isFile()) {
		throw new Error(`Expected binary file is not present: ${binaryPath}`);
	}
	if (info.size === 0) {
		throw new Error(`Binary file is empty: ${binaryPath}`);
	}
	console.log(`Verified TUI binary for ${target}: ${binaryPath}`);
};

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`TUI binary verification failed: ${message}`);
	process.exit(1);
});
