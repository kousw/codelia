#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkInstalledAutoReview,
	checkInstalledMxc,
	checkInstalledShell,
	isolatedSmokeEnv,
} from "./release-smoke-shell.mjs";
import { tuiPlatforms } from "./tui-platforms.mjs";

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
	const platform = tuiPlatforms.get(key);
	if (!platform) {
		throw new Error(
			`Unsupported smoke target ${key}. Supported: ${[...tuiPlatforms.keys()].join(", ")}`,
		);
	}
	return { key, ...platform };
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

const credentialHelperFixture = `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveTrustedMacOsCredentialHelper } = require("@codelia/storage");
const [credentialsDir, source] = process.argv.slice(1);
const workspace = path.join(path.dirname(credentialsDir), "workspace");
fs.mkdirSync(workspace);
const opts = { credentialsDir, untrustedRoots: [workspace] };
const readOnly = { ...opts, stagePackagedHelper: false };

assert.equal(resolveTrustedMacOsCredentialHelper(readOnly)?.file, fs.realpathSync(source));
const storeLink = path.join(workspace, "package-store-link");
fs.linkSync(source, storeLink);
assert.equal(resolveTrustedMacOsCredentialHelper(readOnly), null);
assert.equal(fs.existsSync(credentialsDir), false);
const insideWorkspace = path.join(workspace, "credentials");
assert.equal(resolveTrustedMacOsCredentialHelper({ ...opts, credentialsDir: insideWorkspace }), null);
assert.equal(fs.existsSync(insideWorkspace), false);
const missingWorkspace = path.join(path.dirname(workspace), "missing-workspace");
assert.equal(resolveTrustedMacOsCredentialHelper({
  credentialsDir: path.join(missingWorkspace, "credentials"),
  untrustedRoots: [missingWorkspace],
}), null);
assert.equal(fs.existsSync(missingWorkspace), false);

const prepared = resolveTrustedMacOsCredentialHelper(opts);
assert.ok(prepared, "could not resolve a verified copy of the hardlinked credential helper");
assert.ok(prepared.file.startsWith(fs.realpathSync(credentialsDir) + path.sep));
assert.equal(fs.statSync(prepared.file).nlink, 1);
assert.equal(fs.statSync(prepared.file).mode & 0o777, 0o500);
assert.deepEqual(fs.readFileSync(prepared.file), fs.readFileSync(source));
assert.deepEqual(resolveTrustedMacOsCredentialHelper(readOnly), prepared);

fs.unlinkSync(storeLink);
assert.deepEqual(resolveTrustedMacOsCredentialHelper(opts), prepared);
fs.appendFileSync(source, "tampered");
assert.equal(resolveTrustedMacOsCredentialHelper(opts), null);
`;

const main = async () => {
	const {
		key,
		packageDir: tuiPackageDir,
		includesMxc,
		includesCredentialHelper,
	} = detectTarget();
	const npmCache =
		process.env.npm_config_cache?.trim() ||
		process.env.NPM_CONFIG_CACHE?.trim() ||
		path.join(rootDir, ".cache", "npm");
	mkdirSync(npmCache, { recursive: true });
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

		const helperName = "codelia-credential-helper";
		if (includesCredentialHelper) {
			const stagedHelper = path.resolve(
				rootDir,
				tuiPackageDir,
				"bin",
				helperName,
			);
			const digest = createHash("sha256")
				.update(readFileSync(stagedHelper))
				.digest("hex");
			// Local smoke runs after staging, with only the host architecture available.
			run("bun", ["run", "--filter", "@codelia/storage", "build"], {
				env: {
					...env,
					[`CODELIA_CREDENTIAL_HELPER_SHA256_${process.arch.toUpperCase()}`]:
						digest,
				},
			});
		}

		const packDir = path.join(tempRoot, "tarballs");
		mkdirSync(packDir, { recursive: true });

		const tarballs = [];
		tarballs.push(packPackage(tuiPackageDir, env, packDir));
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
			env: isolatedSmokeEnv(path.join(tempRoot, "cli-smoke")),
		});
		if (includesCredentialHelper) {
			const source = path.join(
				projectDir,
				"node_modules",
				"@codelia",
				`tui-${key}`,
				"bin",
				helperName,
			);
			run(
				nodeCmd,
				[
					"-e",
					credentialHelperFixture,
					path.join(tempRoot, "helper-credentials"),
					source,
				],
				{ cwd: projectDir },
			);
			console.log("Credential helper release smoke passed.");
		}
		await checkInstalledShell(projectDir, tempRoot);
		if (includesMxc) await checkInstalledMxc(projectDir, tempRoot);
		await checkInstalledAutoReview(projectDir, tempRoot);

		console.log(`Release smoke passed on ${key}.`);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
};

await main();
