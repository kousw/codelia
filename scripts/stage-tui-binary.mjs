#!/usr/bin/env node

import fsSync from "node:fs";
import { access, chmod, copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tuiPlatforms } from "./tui-platforms.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const parseArgs = () => {
	const args = process.argv.slice(2);
	let platform = process.platform;
	let arch = process.arch;
	let source;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--platform") {
			platform = args[i + 1] ?? platform;
			i += 1;
			continue;
		}
		if (arg === "--arch") {
			arch = args[i + 1] ?? arch;
			i += 1;
			continue;
		}
		if (arg === "--source") {
			source = args[i + 1];
			i += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return { arch, platform, source };
};

const ensureReadableFile = async (filePath) => {
	await access(filePath, fsSync.constants.R_OK);
	const info = await stat(filePath);
	if (!info.isFile()) {
		throw new Error(`Not a file: ${filePath}`);
	}
};

const main = async () => {
	const { arch, platform, source } = parseArgs();
	const key = `${platform}-${arch}`;
	const target = tuiPlatforms.get(key);
	if (!target) {
		throw new Error(
			`Unsupported target ${key}. Supported targets: ${[...tuiPlatforms.keys()].join(", ")}`,
		);
	}

	const sourceBinary = source
		? path.resolve(source)
		: path.resolve(
				rootDir,
				"crates",
				"tui",
				"target",
				"release",
				target.binaryName,
			);
	const destinationDir = path.resolve(rootDir, target.packageDir, "bin");
	const destinationPath = path.resolve(destinationDir, target.binaryName);

	await ensureReadableFile(sourceBinary);
	const mxcDir = path.join(rootDir, "crates", "mxc-launcher");
	const mxcSource = path.join(
		mxcDir,
		"target",
		"release",
		"codelia-mxc-launcher",
	);
	if (target.includesMxc) await ensureReadableFile(mxcSource);
	const credHelperSource = path.join(
		rootDir,
		"crates",
		"credential-helper",
		"target",
		"release",
		"codelia-credential-helper",
	);
	if (target.includesCredentialHelper) {
		await ensureReadableFile(credHelperSource);
	}
	await mkdir(destinationDir, { recursive: true });
	await copyFile(sourceBinary, destinationPath);
	if (platform !== "win32") {
		await chmod(destinationPath, 0o755);
	}
	if (target.includesMxc) {
		const launcher = path.join(destinationDir, "codelia-mxc-launcher");
		await copyFile(mxcSource, launcher);
		await chmod(launcher, 0o755);
		await copyFile(
			path.join(mxcDir, "MXC-LICENSE.md"),
			path.join(destinationDir, "MXC-LICENSE.md"),
		);
	}
	if (target.includesCredentialHelper) {
		const helperDest = path.join(destinationDir, "codelia-credential-helper");
		await copyFile(credHelperSource, helperDest);
		await chmod(helperDest, 0o755);
	}

	console.log(
		`Staged ${sourceBinary} -> ${path.relative(rootDir, destinationPath)}`,
	);
};

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to stage TUI binary: ${message}`);
	process.exit(1);
});
