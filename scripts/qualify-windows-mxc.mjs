import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, isIPv4 } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { tryConnection } from "./windows-mxc-worker.mjs";

const result = {
	schema: 1,
	observedAt: new Date().toISOString(),
	host: {
		platform: process.platform,
		arch: process.arch,
		release: os.release(),
		node: process.version,
	},
	backend: "processcontainer",
	status: "unavailable",
	observations: {},
};
const fixtureArguments = [
	"",
	"two words",
	'embedded"quote',
	"trailing \\",
	"日本語",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const officialLibraryHash = {
	arm64: "61567181014a90466ba77a7ccc894e6292389dc911c541a5596712b70e614fdb",
	x64: "88909c26c793c7785bed67583202cd5f5d473bc1eb90b7a022f02a63201caf54",
};
async function listen(address) {
	const server = createServer((socket) => socket.end());
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(address, resolve);
	});
	return server;
}
const close = (server) => new Promise((resolve) => server.close(resolve));
const blockedFile = (value) => value === "EACCES" || value === "EPERM";
const blockedConnection = (value) =>
	[
		"EACCES",
		"EPERM",
		"ECONNREFUSED",
		"timeout",
		"ENETUNREACH",
		"EHOSTUNREACH",
	].includes(value);

async function qualify() {
	if (process.platform !== "win32") return;
	const { buildQualificationRequest } = await import(
		"./windows-mxc-request.mts"
	);
	if (!process.argv[2]) throw new Error("sdk_prefix_required");
	if (process.env.MXC_FFI_DIR || !["x64", "arm64"].includes(process.arch))
		throw new Error("unsupported_library_configuration");
	const prefix = path.resolve(process.argv[2]);
	const load = createRequire(path.join(prefix, "package.json"));
	const manifest = load.resolve("@microsoft/mxc-sdk/package.json");
	const { version } = JSON.parse(await readFile(manifest, "utf8"));
	if (version !== "1.1.0") throw new Error("sdk_version_mismatch");
	const dll = path.join(
		path.dirname(manifest),
		"bin",
		process.arch,
		"mxc_ffi.dll",
	);
	result.sdk = {
		version,
		nativeSha256: hash(await readFile(dll)),
		nodeSha256: hash(await readFile(process.execPath)),
	};
	if (result.sdk.nativeSha256 !== officialLibraryHash[process.arch])
		throw new Error("official_library_digest_mismatch");
	const sdk = await import(
		pathToFileURL(load.resolve("@microsoft/mxc-sdk/v1")).href
	);
	result.sdk.contract = sdk.SDK_CONTRACT_VERSION;
	if (result.sdk.contract !== "1.0.0") throw new Error("sdk_contract_mismatch");
	const system = process.env.SystemRoot;
	if (!system || !path.isAbsolute(system))
		throw new Error("missing_system_root");
	const ubr = execFileSync(
		path.join(system, "System32", "reg.exe"),
		[
			"query",
			"HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
			"/v",
			"UBR",
		],
		{ encoding: "utf8" },
	).match(/REG_DWORD\s+(0x[0-9a-f]+)/iu);
	if (!ubr) throw new Error("missing_os_revision");
	result.host.updateBuildRevision = Number(ubr[1]);

	const peer = process.env.CODELIA_QUALIFICATION_PEER;
	const [peerIp, peerPort, extra] = (peer ?? "").split(":");
	if (
		peer &&
		(!isIPv4(peerIp) ||
			!/^\d+$/u.test(peerPort) ||
			Number(peerPort) < 1 ||
			Number(peerPort) > 65535 ||
			extra !== undefined)
	)
		throw new Error("invalid_controlled_peer");
	const root = await mkdtemp(path.join(os.tmpdir(), "codelia-mxc-"));
	const servers = [];
	const previous = process.env.CODELIA_MXC_HOST_SENTINEL;
	try {
		const at = (...parts) => path.join(root, ...parts);
		for (const dir of [
			"workspace/protected",
			"scratch",
			"reference",
			"worker",
			"acl-baseline",
		])
			await mkdir(at(dir), { recursive: true });
		for (const dir of [
			"workspace",
			"workspace/protected",
			"reference",
			"acl-baseline",
		])
			await writeFile(at(dir, "input"), "codelia-fixture");
		const worker = at("worker", "worker.mjs");
		await copyFile(
			new URL("./windows-mxc-worker.mjs", import.meta.url),
			worker,
		);
		// Apply a known host ACL only to the newly created synthetic directory.
		execFileSync(
			path.join(system, "System32", "icacls.exe"),
			[at("acl-baseline"), "/grant", "*S-1-15-2-1:(OI)(CI)(M)", "/T"],
			{ stdio: "pipe" },
		);
		const pipeName = `\\\\.\\pipe\\codelia-mxc-${randomUUID()}`;
		const tcp = await listen({ host: "127.0.0.1", port: 0 });
		servers.push(tcp);
		servers.push(await listen(pipeName));
		const port = tcp.address().port;
		const targets = [{ host: "127.0.0.1", port }, { path: pipeName }];
		if (peer) targets.push({ host: peerIp, port: Number(peerPort) });
		for (const target of targets)
			if ((await tryConnection(target)) !== "connected")
				throw new Error("host_positive_control_failed");
		process.env.CODELIA_MXC_HOST_SENTINEL = "fixture";

		function requireProbe(input, label) {
			const probe = sdk.probe(input);
			result.observations[`${label}Probe`] = {
				tier: probe.tier ?? null,
				baseContainer: probe.probes.baseContainerApiPresent,
				nativeDeny: probe.probes.baseContainerSupportsDenyPaths,
				daclAugmentation: probe.needsDaclAugmentation ?? null,
				warningCount: probe.warnings.length,
			};
			if (
				probe.error ||
				probe.tier !== "base-container" ||
				probe.needsDaclAugmentation !== false ||
				!probe.probes.baseContainerApiPresent ||
				!probe.probes.baseContainerSupportsDenyPaths
			)
				throw new Error("native_policy_unavailable");
		}
		const options = { telemetry: { enabled: false } };
		let passed = true;
		for (const profile of ["investigation", "development"]) {
			const input = buildQualificationRequest(
				root,
				process.execPath,
				system,
				profile,
				"controls",
				[String(port), pipeName, ...fixtureArguments],
				peer,
			);
			requireProbe(input, profile);
			const describe = (result) => ({
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				stdoutBytes: Buffer.byteLength(result.stdout || ""),
				stderrBytes: Buffer.byteLength(result.stderr || ""),
				warnings: result.warnings?.length,
				codes: [...new Set((result.stderr || "").match(/\b(?:EACCES|EPERM|EINVAL|ENOENT|UNKNOWN|MODULE_NOT_FOUND|ERR_[A-Z_]+|Assertion|uv_[a-z_]+)\b/g) ?? [])],
			});
			if (profile === "investigation") {
				if (process.env.CODELIA_CI_EXIT_FIXTURE) {
                    const native = at("worker", "native-exit.exe");
                    await copyFile(process.env.CODELIA_CI_EXIT_FIXTURE, native);
                    const trial = await sdk.run({...input, command: '"' + native + '"'}, options);
                    result.observations.nativeExit = {...describe(trial), matches: trial.exitCode === 42};
                }
                const simple = await sdk.run({...input, command: '"' + process.execPath + '" --version'}, options);
				result.observations.nodeVersion = {...describe(simple), matches: simple.stdout?.trim() === process.version};
			}
			const execution = await sdk.run(input, options);
			result.observations[profile + "Execution"] = describe(execution);
			if (execution.exitCode !== 0 || execution.timedOut)
				throw new Error("fixture_failed_to_complete");
			for (const target of targets)
				if ((await tryConnection(target)) !== "connected")
					throw new Error("host_positive_control_failed");
			const data = JSON.parse(execution.stdout.trim());
			result.observations[profile] = data;
			const filePolicy =
				data.scratchWrite === "allowed" &&
				data.workspaceRead === "allowed" &&
				data.explicitRead === "allowed" &&
				blockedFile(data.referenceWrite) &&
				blockedFile(data.privateRead) &&
				blockedFile(data.privateWrite) &&
				(profile === "development"
					? data.workspaceWrite === "allowed"
					: blockedFile(data.workspaceWrite));
			passed &&=
				filePolicy &&
				data.cwdMatches === true &&
				data.hostSentinelInherited === false &&
				JSON.stringify(data.argv) === JSON.stringify(fixtureArguments) &&
				blockedConnection(data.loopback) &&
				(!peer || blockedConnection(data.peer));
		}
		const tree = buildQualificationRequest(
			root,
			process.execPath,
			system,
			"development",
			"tree",
			[],
			peer,
		);
		requireProbe(tree, "cancel");
		const proc = await sdk.spawn(tree, options);
		try {
			proc.standardInput?.end();
			const done = proc.wait();
			const deadline = Date.now() + 6000;
			let pid;
			while (Date.now() < deadline) {
				const value = await readFile(at("scratch", "leaf"), "utf8").catch(
					() => "",
				);
				if (/^[1-9]\d*$/u.test(value)) {
					pid = Number(value);
					break;
				}
				await delay(50);
			}
			if (!pid) throw new Error("descendant_positive_control_failed");
			process.kill(pid, 0);
			proc.kill();
			const termination = await done;
			const limit = Date.now() + 1500;
			let gone = false;
			while (Date.now() < limit) {
				try {
					process.kill(pid, 0);
				} catch (error) {
					if (error.code === "ESRCH") {
						gone = true;
						break;
					}
					throw error;
				}
				await delay(50);
			}
			result.observations.cancellation = {
				leafStarted: true,
				leafTerminated: gone,
				timedOut: termination.timedOut,
			};
			passed &&= gone && !termination.timedOut;
		} finally {
			proc.dispose();
		}
		result.status = passed ? "observed_subset_passed" : "failed";
	} finally {
		if (previous === undefined) delete process.env.CODELIA_MXC_HOST_SENTINEL;
		else process.env.CODELIA_MXC_HOST_SENTINEL = previous;
		await Promise.all(servers.map(close));
		await rm(root, { recursive: true, force: true, maxRetries: 3 });
	}
}

try {
	await qualify();
} catch (error) {
	result.status = "inconclusive";
	// Diagnostic text can contain local paths. Publish a stage-independent code only.
	result.error = /^[a-z][a-z_]+$/.test(error.message)
		? error.message
		: (error.code ?? error.name);
}
console.log(JSON.stringify(result, null, 2));
if (result.status !== "observed_subset_passed") process.exitCode = 1;
