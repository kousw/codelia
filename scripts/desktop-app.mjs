import { spawnSync } from "node:child_process";
import { copyFile, mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function options(args) {
	const result = { name: "Codelia", bundleId: "dev.codelia.desktop" };
	const keys = new Map([
		["--name", "name"],
		["--bundle-id", "bundleId"],
		["--validation-fixture", "fixtureRoot"],
		["--provider-url", "providerBaseUrl"],
	]);
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") continue;
		const key = keys.get(args[i]);
		if (!key || !args[i + 1])
			throw new Error(`Invalid packaging argument: ${args[i]}`);
		result[key] = args[++i];
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/.test(result.name))
		throw new Error("Invalid app name");
	if (!/^dev\.codelia\.desktop(?:\.[a-z0-9-]+)*$/.test(result.bundleId))
		throw new Error("Invalid Codelia bundle ID");
	if (result.fixtureRoot || result.providerBaseUrl) {
		if (
			result.name === "Codelia" ||
			result.bundleId === "dev.codelia.desktop"
		) {
			throw new Error("Validation needs its own app name and bundle identity");
		}
		if (!result.fixtureRoot || !result.providerBaseUrl)
			throw new Error("Validation needs fixture and provider URL");
		if (
			!/^\/(?:private\/)?tmp\/[^/]+/.test(result.fixtureRoot) ||
			result.fixtureRoot.split("/").includes("..")
		) {
			throw new Error(
				"Validation fixture must be a dedicated absolute temporary directory",
			);
		}
		const match = /^http:\/\/127\.0\.0\.1:([0-9]+)\/v1$/.exec(
			result.providerBaseUrl,
		);
		if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535)
			throw new Error("Validation provider must be loopback");
	}
	return result;
}

export function isMachO(bytes) {
	return [
		"cffaedfe",
		"feedfacf",
		"cafebabe",
		"bebafeca",
		"cafebabf",
		"bfbafeca",
	].includes(bytes.subarray(0, 4).toString("hex"));
}

export async function packageApp(repo, args) {
	const config = options(args);
	const source = join(repo, "crates/desktop/target/debug/codelia-desktop");
	const handle = await open(source, "r");
	const header = Buffer.alloc(4);
	try {
		await handle.read(header, 0, 4, 0);
	} finally {
		await handle.close();
	}
	if (!isMachO(header))
		throw new Error("Desktop main executable must be native Mach-O");
	const app = join(repo, "crates/desktop/target", `${config.name}.app`);
	const contents = join(app, "Contents");
	const macos = join(contents, "MacOS");
	if (config.fixtureRoot) {
		// Refuse overwriting a prior validation instance or changing its identity/config.
		await mkdir(app);
	}
	await mkdir(macos, { recursive: true });
	const executable = join(macos, "codelia-desktop");
	const temporary = `${executable}.new-${crypto.randomUUID()}`;
	await copyFile(source, temporary);
	await rename(temporary, executable);
	const info = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>codelia-desktop</string>
<key>CFBundleIdentifier</key><string>${config.bundleId}</string>
<key>CFBundleName</key><string>${config.name}</string>
<key>CFBundleDisplayName</key><string>${config.name}</string>
<key>CFBundleVersion</key><string>0.1.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSDocumentsFolderUsageDescription</key><string>Codelia reads your selected coding workspace and development runtime source.</string>
</dict></plist>`;
	await writeFile(join(contents, "Info.plist"), info);
	if (config.fixtureRoot) {
		await mkdir(join(contents, "Resources"), { recursive: true });
		await writeFile(
			join(contents, "Resources/codelia-validation.json"),
			JSON.stringify({
				version: 1,
				fixture_root: config.fixtureRoot,
				provider_base_url: config.providerBaseUrl,
			}),
		);
	}
	// Local ad-hoc signing binds this bundle's own native main, Info.plist and
	// resources. No certificate, keychain, TCC database or OS setting is touched.
	const signing = spawnSync(
		"codesign",
		["--force", "--sign", "-", "--identifier", config.bundleId, app],
		{ encoding: "utf8" },
	);
	if (signing.status !== 0)
		throw new Error(`Local bundle signing failed: ${signing.stderr}`);
	const verify = spawnSync("codesign", ["--verify", "--strict", app], {
		encoding: "utf8",
	});
	if (verify.status !== 0)
		throw new Error(`Local bundle verification failed: ${verify.stderr}`);
	return app;
}

if (import.meta.main) {
	const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	try {
		console.log(await packageApp(repo, process.argv.slice(2)));
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
