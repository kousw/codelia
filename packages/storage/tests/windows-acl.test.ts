import { describe, expect, test } from "bun:test";
import {
	enforceWindowsOwnerOnlyDacl,
	parseWhoamiUserCsv,
	verifyIcaclsOwnerOnly,
} from "../src/windows-acl";

describe("Windows credentials directory ACL verification", () => {
	test("parseWhoamiUserCsv extracts user account and SID", () => {
		expect(
			parseWhoamiUserCsv('"DESKTOP\\alice","S-1-5-21-1234-5678-9012-1001"\r\n'),
		).toEqual({
			account: "DESKTOP\\alice",
			sid: "S-1-5-21-1234-5678-9012-1001",
		});
		expect(parseWhoamiUserCsv("unexpected output")).toBeNull();
	});

	test("verifyIcaclsOwnerOnly accepts owner and SYSTEM explicit ACEs", () => {
		const target = "C:\\Users\\alice\\.codelia\\credentials";
		const output = [
			`${target} DESKTOP\\alice:(OI)(CI)(F)`,
			"                  NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
			"",
			"Successfully processed 1 files; Failed processing 0 files",
		].join("\r\n");
		expect(verifyIcaclsOwnerOnly(output, target, ["DESKTOP\\alice"])).toEqual({
			ok: true,
		});
	});

	test("verifyIcaclsOwnerOnly rejects inherited or shared principals", () => {
		const target = "C:\\Users\\alice\\.codelia\\credentials";
		const sharedOutput = [
			`${target} DESKTOP\\alice:(OI)(CI)(F)`,
			"                  BUILTIN\\Users:(OI)(CI)(RX)",
		].join("\r\n");
		expect(
			verifyIcaclsOwnerOnly(sharedOutput, target, ["DESKTOP\\alice"]),
		).toEqual({
			ok: false,
			reason: "unexpected_principals",
			unexpectedPrincipals: ["BUILTIN\\Users"],
		});

		const inheritedOutput = [
			`${target} DESKTOP\\alice:(I)(OI)(CI)(F)`,
			"                  NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)",
		].join("\r\n");
		expect(
			verifyIcaclsOwnerOnly(inheritedOutput, target, ["DESKTOP\\alice"]),
		).toEqual({
			ok: false,
			reason: "inherited_ace_present",
		});
	});

	test("enforceWindowsOwnerOnlyDacl invokes absolute System32 binaries, verifies directory owner SID, and rejects shared ACLs", async () => {
		const target = "C:\\Users\\alice\\.codelia\\credentials";
		const env = { SystemRoot: "C:\\Windows" };
		const invoked: Array<{ file: string; cwd?: string }> = [];
		const runner = async (
			file: string,
			args: readonly string[],
			options?: { cwd?: string },
		) => {
			invoked.push({ file, cwd: options?.cwd });
			if (file.endsWith("\\whoami.exe")) {
				return {
					stdout: '"DESKTOP\\alice","S-1-5-21-1234-5678-9012-1001"\r\n',
					stderr: "",
				};
			}
			if (file.endsWith("\\powershell.exe")) {
				return {
					stdout: "S-1-5-21-1234-5678-9012-1001|false\r\n",
					stderr: "",
				};
			}
			if (file.endsWith("\\icacls.exe") && args.length === 1) {
				return {
					stdout: `${target} DESKTOP\\alice:(OI)(CI)(F)\r\n  Everyone:(OI)(CI)(R)\r\n`,
					stderr: "",
				};
			}
			return { stdout: "", stderr: "" };
		};
		await expect(
			enforceWindowsOwnerOnlyDacl(target, runner, env),
		).rejects.toThrow("unsafe_windows_credentials_acl: unexpected_principals");

		expect(invoked.length).toBeGreaterThanOrEqual(4);
		for (const call of invoked) {
			expect(call.file.startsWith("C:\\Windows\\System32\\")).toBe(true);
			expect(call.cwd).toBe("C:\\Windows\\System32");
		}
	});

	test("enforceWindowsOwnerOnlyDacl rejects directory owned by another user SID even when DACL looks clean", async () => {
		const target = "C:\\Users\\alice\\.codelia\\credentials";
		const env = { SystemRoot: "C:\\Windows" };
		const calls: string[] = [];
		const runner = async (file: string) => {
			calls.push(file);
			if (file.endsWith("\\whoami.exe")) {
				return {
					stdout: '"DESKTOP\\alice","S-1-5-21-1234-5678-9012-1001"\r\n',
					stderr: "",
				};
			}
			if (file.endsWith("\\powershell.exe")) {
				// Owned by another user SID
				return {
					stdout: "S-1-5-21-1234-5678-9012-1002|false\r\n",
					stderr: "",
				};
			}
			return { stdout: "", stderr: "" };
		};
		await expect(
			enforceWindowsOwnerOnlyDacl(target, runner, env),
		).rejects.toThrow("unsafe_windows_credentials_acl: owner_mismatch");
		// Must reject before running icacls
		expect(calls.some((file) => file.endsWith("\\icacls.exe"))).toBe(false);
	});

	test("enforceWindowsOwnerOnlyDacl rejects reparse point directories and accepts verified owner + clean DACL", async () => {
		const target = "C:\\Users\\alice\\.codelia\\credentials";
		const env = { SystemRoot: "C:\\Windows" };
		const reparseRunner = async (file: string) => {
			if (file.endsWith("\\whoami.exe")) {
				return {
					stdout: '"DESKTOP\\alice","S-1-5-21-1234-5678-9012-1001"\r\n',
					stderr: "",
				};
			}
			return { stdout: "S-1-5-21-1234-5678-9012-1001|true\r\n", stderr: "" };
		};
		await expect(
			enforceWindowsOwnerOnlyDacl(target, reparseRunner, env),
		).rejects.toThrow("unsafe_windows_credentials_acl: reparse_point");

		const okRunner = async (file: string, args: readonly string[]) => {
			if (file.endsWith("\\whoami.exe")) {
				return {
					stdout: '"DESKTOP\\alice","S-1-5-21-1234-5678-9012-1001"\r\n',
					stderr: "",
				};
			}
			if (file.endsWith("\\powershell.exe")) {
				return {
					stdout: "S-1-5-21-1234-5678-9012-1001|false\r\n",
					stderr: "",
				};
			}
			if (file.endsWith("\\icacls.exe") && args.length === 1) {
				return {
					stdout: `${target} DESKTOP\\alice:(OI)(CI)(F)\r\n  NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\r\n`,
					stderr: "",
				};
			}
			return { stdout: "", stderr: "" };
		};
		await expect(
			enforceWindowsOwnerOnlyDacl(target, okRunner, env),
		).resolves.toBeUndefined();
	});
});
