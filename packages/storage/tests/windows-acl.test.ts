import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureStorageDirs, resolveStoragePaths } from "../src/paths";
import {
	enforceWindowsOwnerOnlyDacl,
	ensureCredentialsDirectory,
	resolveWindowsSystem32Dir,
	verifyWindowsCredentialFileAcl,
	verifyWindowsCredentialFileAclSync,
	type WindowsAclRunner,
} from "../src/windows-acl";

const env = { SystemRoot: "C:\\Windows" };
const target = "C:\\Users\\alice\\[config]\\credentials";

test("ordinary storage setup leaves the credentials directory absent", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-storage-"));
	try {
		const paths = resolveStoragePaths({ rootOverride: root });
		await ensureStorageDirs(paths);
		expect((await fs.stat(paths.sessionsDir)).isDirectory()).toBe(true);
		await expect(fs.lstat(paths.credentialsDir)).rejects.toThrow("ENOENT");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("Windows ACL enforcement passes literal paths to an absolute System32 helper", async () => {
	const runner: WindowsAclRunner = async (exe, args, options) => {
		expect(exe).toBe(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
		expect(options?.cwd).toBe("C:\\Windows\\System32");
		expect(args.slice(0, 3)).toEqual([
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
		]);
		expect(options?.env?.CODELIA_ACL_TARGET).toBe(target);
		expect(options?.env?.CODELIA_ACL_OPERATION).toBe("ensure_directory");
		return { stdout: "ok\r\n", stderr: "" };
	};
	await enforceWindowsOwnerOnlyDacl(target, runner, env);
	expect(() => resolveWindowsSystem32Dir({ WINDIR: "relative" })).toThrow(
		"invalid_system_root",
	);
});

test("Windows ACL enforcement fails closed with bounded error codes", async () => {
	for (const reason of [
		"owner_mismatch",
		"reparse_point",
		"unexpected_principals",
		"null_dacl",
		"legacy_write_grant",
	]) {
		await expect(
			enforceWindowsOwnerOnlyDacl(
				target,
				async () => ({ stdout: reason, stderr: "" }),
				env,
			),
		).rejects.toThrow(`unsafe_windows_credentials_acl: ${reason}`);
	}
	await expect(
		enforceWindowsOwnerOnlyDacl(
			target,
			async () => ({ stdout: "unexpected native output", stderr: "" }),
			env,
		),
	).rejects.toThrow("unsafe_windows_credentials_acl: invalid_probe_result");
	await expect(
		enforceWindowsOwnerOnlyDacl(
			target,
			async () => {
				throw new Error(target);
			},
			env,
		),
	).rejects.toThrow("unsafe_windows_credentials_acl: acl_probe_failed");
});

test.skipIf(process.platform !== "win32")(
	"Windows credential reads enforce current and legacy ACLs and reject junctions",
	async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-native-acl-"),
		);
		try {
			const powershell = path.join(
				resolveWindowsSystem32Dir(),
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			);
			const runFixtureScript = (target: string, commands: string[]) =>
				promisify(execFile)(
					powershell,
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						[
							"$ErrorActionPreference = 'Stop'",
							"$item = Get-Item -LiteralPath $env:CODELIA_TEST_ACL_FILE",
							"$acl = $item.GetAccessControl()",
							...commands,
						].join("; "),
					],
					{ env: { ...process.env, CODELIA_TEST_ACL_FILE: target } },
				);
			// Elevated Windows runners can create Administrators-owned objects.
			// Only assign ownership to the empty fixtures created by this test.
			const setFixtureOwner = (target: string) =>
				runFixtureScript(target, [
					"$acl.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User)",
					"$item.SetAccessControl($acl)",
				]);

			const dir = path.join(root, "[credentials]");
			await fs.mkdir(dir);
			await setFixtureOwner(dir);
			await ensureCredentialsDirectory(dir);
			const file = path.join(dir, "auth.json");
			expect(await verifyWindowsCredentialFileAcl(file)).toBe(false);
			await fs.writeFile(file, "{}");
			await setFixtureOwner(file);
			expect(await verifyWindowsCredentialFileAcl(file)).toBe(true);
			expect(verifyWindowsCredentialFileAclSync(file)).toBe(true);

			const updateTestAcl = (commands: string[]) =>
				runFixtureScript(file, [...commands, "$item.SetAccessControl($acl)"]);
			await updateTestAcl([
				"$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
				"$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')",
				"$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'ReadAndExecute', 'Allow'))",
				"$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administrators, 'FullControl', 'Allow'))",
			]);

			await expect(verifyWindowsCredentialFileAcl(file)).rejects.toThrow(
				"unexpected_principals",
			);
			expect(() => verifyWindowsCredentialFileAclSync(file)).toThrow(
				"unexpected_principals",
			);
			expect(await verifyWindowsCredentialFileAcl(file, true)).toBe(true);
			await updateTestAcl([
				"$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
				"$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Modify', 'Allow'))",
			]);
			await expect(verifyWindowsCredentialFileAcl(file, true)).rejects.toThrow(
				"legacy_write_grant",
			);
			expect(() => verifyWindowsCredentialFileAclSync(file, true)).toThrow(
				"legacy_write_grant",
			);
			await updateTestAcl([
				"$acl.SetSecurityDescriptorSddlForm('D:PNO_ACCESS_CONTROL', 'Access')",
			]);
			// .NET can represent a null DACL as its equivalent, Everyone full access.
			await expect(verifyWindowsCredentialFileAcl(file, true)).rejects.toThrow(
				/null_dacl|legacy_write_grant/,
			);

			const junction = path.join(root, "junction");
			await fs.symlink(dir, junction, "junction");
			await expect(enforceWindowsOwnerOnlyDacl(junction)).rejects.toThrow(
				"reparse_point",
			);
			await expect(
				verifyWindowsCredentialFileAcl(path.join(junction, "auth.json")),
			).rejects.toThrow("reparse_point");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
