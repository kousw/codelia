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

	test("enforceWindowsOwnerOnlyDacl fails closed when shared ACL persists", async () => {
		const target = "C:\\Users\\alice\\.codelia\\credentials";
		const runner = async (file: string, args: readonly string[]) => {
			if (file === "whoami.exe") {
				return {
					stdout: '"DESKTOP\\alice","S-1-5-21-1234-5678-9012-1001"\r\n',
					stderr: "",
				};
			}
			if (file === "icacls.exe" && args.length === 1) {
				return {
					stdout: `${target} DESKTOP\\alice:(OI)(CI)(F)\r\n  Everyone:(OI)(CI)(R)\r\n`,
					stderr: "",
				};
			}
			return { stdout: "", stderr: "" };
		};
		await expect(enforceWindowsOwnerOnlyDacl(target, runner)).rejects.toThrow(
			"unsafe_windows_credentials_acl: unexpected_principals",
		);
	});
});
