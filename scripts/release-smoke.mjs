#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const packageOrder = [
	"packages/config",
	"packages/logger",
	"packages/shared-types",
	"packages/protocol",
	"packages/core",
	"packages/storage",
	"packages/config-loader",
	"packages/model-metadata",
	"packages/runtime",
	"packages/cli",
];

const platformPackageByTarget = {
	"darwin-arm64": "packages/tui/darwin-arm64",
	"darwin-x64": "packages/tui/darwin-x64",
	"linux-arm64": "packages/tui/linux-arm64",
	"linux-x64": "packages/tui/linux-x64",
	"win32-x64": "packages/tui/win32-x64",
};

const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";
const nodeCmd = process.execPath;

const run = (cmd, args, opts = {}) => {
	const shell =
		opts.shell ??
		(isWindows && typeof cmd === "string" && cmd.endsWith(".cmd"));
	const result = spawnSync(cmd, args, {
		cwd: opts.cwd ?? rootDir,
		env: opts.env ?? process.env,
		stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		encoding: "utf8",
		shell,
	});
	if (result.status === 0) {
		return result;
	}
	if (result.error) {
		throw new Error(
			`Command failed: ${cmd} ${args.join(" ")}\n${result.error.message}`,
		);
	}
	const stderr = result.stderr ? `\n${result.stderr}` : "";
	throw new Error(`Command failed: ${cmd} ${args.join(" ")}${stderr}`);
};

const detectTarget = () => {
	const key = `${process.platform}-${process.arch}`;
	const pkgDir = platformPackageByTarget[key];
	if (!pkgDir) {
		throw new Error(
			`Unsupported smoke target ${key}. Supported: ${Object.keys(platformPackageByTarget).join(", ")}`,
		);
	}
	return { key, pkgDir };
};

const packPackage = (packageDir, env, packDestination) => {
	const result = run(
		npmCmd,
		["pack", "--json", "--pack-destination", packDestination],
		{
			cwd: path.resolve(rootDir, packageDir),
			env,
			capture: true,
		},
	);
	const stdout = result.stdout.trim();
	const match = stdout.match(/\[\s*\{[\s\S]*\]\s*$/);
	if (!match) {
		throw new Error(`Unexpected npm pack output for ${packageDir}: ${stdout}`);
	}
	const parsed = JSON.parse(match[0]);
	const filename = parsed?.[0]?.filename;
	if (!filename) {
		throw new Error(`Unexpected npm pack output for ${packageDir}`);
	}
	return path.resolve(packDestination, filename);
};

const main = () => {
	const { key, pkgDir } = detectTarget();
	const npmCache = path.join(os.tmpdir(), "codelia-npm-cache");
	const env = { ...process.env, npm_config_cache: npmCache };

	const tempRoot = mkdtempSync(
		path.join(os.tmpdir(), "codelia-release-smoke-"),
	);

	try {
		run(
			nodeCmd,
			[
				path.resolve(rootDir, "scripts/stage-tui-binary.mjs"),
				"--platform",
				process.platform,
				"--arch",
				process.arch,
			],
			{
				cwd: rootDir,
				env,
			},
		);

		const packDir = path.join(tempRoot, "tarballs");
		mkdirSync(packDir, { recursive: true });

		const tarballs = [];
		tarballs.push(packPackage(pkgDir, env, packDir));
		for (const packageDir of packageOrder) {
			tarballs.push(packPackage(packageDir, env, packDir));
		}

		const projectDir = path.join(tempRoot, "install");
		mkdirSync(projectDir, { recursive: true });
		run(npmCmd, ["init", "-y"], { cwd: projectDir, env });
		run(npmCmd, ["install", "--no-audit", "--no-fund", ...tarballs], {
			cwd: projectDir,
			env,
		});

		const cliEntry = path.join(
			projectDir,
			"node_modules",
			"@codelia",
			"cli",
			"dist",
			"index.cjs",
		);
		run(nodeCmd, [cliEntry, "mcp", "list"], {
			cwd: projectDir,
			env,
		});

		console.log(`Release smoke passed on ${key}.`);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
};

main();
