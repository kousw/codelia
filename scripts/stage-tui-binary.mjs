#!/usr/bin/env node

import fsSync from "node:fs";
import { access, chmod, copyFile, mkdir, stat } from "node:fs/promises";
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
	const target = TARGETS[key];
	if (!target) {
		throw new Error(
			`Unsupported target ${key}. Supported targets: ${Object.keys(TARGETS).join(", ")}`,
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
	await mkdir(destinationDir, { recursive: true });
	await copyFile(sourceBinary, destinationPath);
	if (platform !== "win32") {
		await chmod(destinationPath, 0o755);
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
