#!/usr/bin/env node

import fsSync from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tuiPlatforms } from "./tui-platforms.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

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
	const platform = tuiPlatforms.get(target);
	if (!platform) {
		throw new Error(
			`Missing or unsupported --target value. Supported: ${[...tuiPlatforms.keys()].join(", ")}`,
		);
	}

	const { packageDir, binaryName, includesMxc } = platform;
	const binaryPath = path.resolve(rootDir, packageDir, "bin", binaryName);
	await access(binaryPath, fsSync.constants.R_OK);
	const info = await stat(binaryPath);
	if (!info.isFile()) {
		throw new Error(`Expected binary file is not present: ${binaryPath}`);
	}
	if (info.size === 0) {
		throw new Error(`Binary file is empty: ${binaryPath}`);
	}
	if (includesMxc) {
		const bin = path.dirname(binaryPath);
		const launcher = path.join(bin, "codelia-mxc-launcher");
		const license = path.join(bin, "MXC-LICENSE.md");
		const launcherInfo = await stat(launcher);
		const licenseInfo = await stat(license);
		if (
			!launcherInfo.isFile() ||
			!launcherInfo.size ||
			!(launcherInfo.mode & 0o100) ||
			!licenseInfo.isFile() ||
			!licenseInfo.size
		)
			throw new Error("MXC launcher or its license is invalid");
	}
	console.log(`Verified TUI binary for ${target}: ${binaryPath}`);
};

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`TUI binary verification failed: ${message}`);
	process.exit(1);
});
