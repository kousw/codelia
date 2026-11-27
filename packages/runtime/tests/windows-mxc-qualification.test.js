import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	describeQualificationControls,
	describeQualificationError,
	describeQualificationExecution,
} from "../../../scripts/qualify-windows-mxc.mjs";
import { buildQualificationRequest } from "../../../scripts/windows-mxc-request.mts";

const scripts = path.resolve(import.meta.dir, "../../../scripts");
const execute = promisify(execFile);

test("MXC qualification request selects the explicit V1 backend for both profiles", () => {
	const root = path.resolve("qualification");
	for (const profile of ["investigation", "development"]) {
		const req = buildQualificationRequest(
			root,
			process.execPath,
			"SystemRoot",
			profile,
			"controls",
			["", 'a"b'],
		);
		expect(req.containment).toEqual({ type: "processcontainer" });
		expect(req.network).toEqual({
			egress: { default: "deny" },
			ingress: { default: "deny", hostLoopback: "deny" },
		});
		expect(req.inheritDefaultEnvironment).toBe(false);
		const scratch = path.join(root, "scratch");
		expect(req.environment).toEqual({
			SystemRoot: "SystemRoot",
			LOCALAPPDATA: scratch,
			TEMP: scratch,
			TMP: scratch,
		});
		expect(req.filesystem?.deniedPaths).toEqual([
			path.join(root, "workspace", "protected"),
		]);
		expect(
			req.filesystem?.readwritePaths?.includes(path.join(root, "workspace")),
		).toBe(profile === "development");
		expect(req.command.endsWith('"" "a\\"b"')).toBe(true);
	}
});

test.skipIf(process.platform === "win32")(
	"qualification cannot report observations on a non-Windows host",
	async () => {
		const child = await execute("node", [
			path.join(scripts, "qualify-windows-mxc.mjs"),
		]).catch((error) => error);
		expect(child.code).toBe(1);
		expect(JSON.parse(child.stdout)).toMatchObject({
			status: "unavailable",
			observations: {},
		});
	},
);

test("execution diagnostics preserve outcome and known codes without embedding raw worker output", () => {
	const stdout = "command payload";
	const stderr = String.raw`Cannot open C:\Users\example\private.mjs
Error [ERR_MODULE_NOT_FOUND]
code: 'ERR_MODULE_NOT_FOUND'
EACCES: denied
code: 'UNKNOWN_CODE'
ENOENT_SUFFIX is not a standalone code`;
	expect(
		describeQualificationExecution({
			exitCode: 1,
			timedOut: false,
			stdout,
			stderr,
			warnings: ["private warning text"],
		}),
	).toEqual({
		exitCode: 1,
		timedOut: false,
		stdoutBytes: Buffer.byteLength(stdout),
		stderrBytes: Buffer.byteLength(stderr),
		stderrCodes: ["EACCES", "ERR_MODULE_NOT_FOUND"],
		warningCount: 1,
	});
	expect(
		describeQualificationExecution({
			exitCode: -1,
			timedOut: true,
			stdout: "",
			stderr: "",
			warnings: [],
		}),
	).toEqual({
		exitCode: -1,
		timedOut: true,
		stdoutBytes: 0,
		stderrBytes: 0,
		stderrCodes: [],
		warningCount: 0,
	});
});

test("misparsed worker observations cannot disclose arguments or unexpected field values", () => {
	const local = String.raw`C:\Users\example\worker.mjs`;
	const observation = describeQualificationControls({
		argv: [local],
		cwdMatches: false,
		hostSentinelInherited: false,
		workspaceRead: "allowed",
		privateRead: "EACCES",
		namedPipe: local,
		extra: local,
	});
	expect(observation).toMatchObject({
		argvMatches: false,
		cwdMatches: false,
		hostSentinelInherited: false,
		workspaceRead: "allowed",
		privateRead: "EACCES",
		namedPipe: "unknown",
	});
	expect(observation.argv).toBeUndefined();
	expect(JSON.stringify(observation)).not.toContain("example");
});

test("SDK exceptions expose only an approved code and a numeric platform status", () => {
	const local = String.raw`C:\Users\example\worker.mjs`;
	expect(
		describeQualificationError({
			code: "policy_validation",
			nativeCode: "0x80070005",
			message: local,
		}),
	).toEqual({ error: "policy_validation", nativeCode: "0x80070005" });
	expect(
		describeQualificationError({
			code: local,
			nativeCode: `${local}\n0x80070005`,
			message: local,
		}),
	).toEqual({ error: "qualification_error" });
});

test("portable unprotected controls reach the synthetic listener and files", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "codelia-mxc-controls-"));
	const tcp = createServer((client) => client.end());
	const pipe = createServer((client) => client.end());
	try {
		for (const dir of [
			"workspace/protected",
			"scratch",
			"reference",
			"acl-baseline",
		])
			await mkdir(path.join(root, dir), { recursive: true });
		for (const dir of [
			"workspace",
			"workspace/protected",
			"reference",
			"acl-baseline",
		])
			await writeFile(path.join(root, dir, "input"), "codelia-fixture");
		const pipeName =
			process.platform === "win32"
				? `\\\\.\\pipe\\codelia-test-${process.pid}`
				: path.join(root, "ipc");
		await Promise.all([
			new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve)),
			new Promise((resolve) => pipe.listen(pipeName, resolve)),
		]);
		const address = tcp.address();
		if (!address || typeof address === "string")
			throw new Error("expected test port");
		const { stdout } = await execute(
			"node",
			[
				path.join(scripts, "windows-mxc-worker.mjs"),
				"controls",
				root,
				String(address.port),
				pipeName,
				"",
				"two words",
				'a"b',
			],
			{
				cwd: path.join(root, "workspace"),
				env: {
					...process.env,
					CODELIA_TEST_QUALIFICATION_PEER: "",
					CODELIA_TEST_MXC_HOST_SENTINEL: "test",
				},
			},
		);
		expect(JSON.parse(stdout)).toMatchObject({
			argv: ["", "two words", 'a"b'],
			hostSentinelInherited: true,
			workspaceWrite: "allowed",
			privateRead: "allowed",
			privateWrite: "allowed",
			explicitRead: "allowed",
			referenceWrite: "allowed",
			scratchWrite: "allowed",
			namedPipe: "connected",
			loopback: "connected",
			peer: "untested",
		});
	} finally {
		tcp.close();
		pipe.close();
		await rm(root, { recursive: true, force: true });
	}
});
