import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SYSTEM_SID = "S-1-5-18";

const ALLOWED_SYSTEM_PRINCIPALS = new Set([
	"nt authority\\system",
	"*s-1-5-18",
	"s-1-5-18",
]);

export type IcaclsVerificationResult =
	| { ok: true }
	| { ok: false; reason: string; unexpectedPrincipals?: string[] };

/**
 * Parse `icacls <path>` output and verify that every ACE belongs strictly to
 * the current user or NT AUTHORITY\SYSTEM, with no inherited/shared principals.
 */
export const verifyIcaclsOwnerOnly = (
	icaclsOutput: string,
	targetPath: string,
	allowedPrincipals: readonly string[],
): IcaclsVerificationResult => {
	const allowed = new Set(
		[...allowedPrincipals, ...ALLOWED_SYSTEM_PRINCIPALS].map((entry) =>
			entry.trim().toLowerCase(),
		),
	);
	const lines = icaclsOutput
		.split(/\r?\n/u)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	const aceLines: string[] = [];
	const normalizedTarget = targetPath.trim().toLowerCase();

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^successfully processed\b/iu.test(trimmed)) continue;
		if (trimmed.toLowerCase().startsWith(normalizedTarget)) {
			const rest = trimmed.slice(normalizedTarget.length).trim();
			if (rest) aceLines.push(rest);
			continue;
		}
		if (line.startsWith(" ") || line.startsWith("\t")) {
			aceLines.push(trimmed);
		}
	}

	if (aceLines.length === 0) {
		return { ok: false, reason: "no_aces_observed" };
	}

	const unexpected: string[] = [];
	for (const ace of aceLines) {
		const separator = ace.indexOf(":");
		if (separator <= 0) {
			return { ok: false, reason: "unparseable_ace" };
		}
		const principal = ace.slice(0, separator).trim().toLowerCase();
		const rights = ace.slice(separator + 1);
		if (/\(I\)/u.test(rights)) {
			return { ok: false, reason: "inherited_ace_present" };
		}
		if (!allowed.has(principal)) {
			unexpected.push(ace.slice(0, separator).trim());
		}
	}

	if (unexpected.length > 0) {
		return {
			ok: false,
			reason: "unexpected_principals",
			unexpectedPrincipals: unexpected,
		};
	}

	return { ok: true };
};

export const parseWhoamiUserCsv = (
	output: string,
): { account: string; sid: string } | null => {
	const line = output
		.split(/\r?\n/u)
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	if (!line) return null;
	const match = /^"([^"]+)","(S-1-[0-9-]+)"$/u.exec(line);
	if (!match) return null;
	return { account: match[1], sid: match[2] };
};

export type WindowsAclRunner = (
	file: string,
	args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: WindowsAclRunner = async (file, args) => {
	const result = await execFileAsync(file, [...args], {
		windowsHide: true,
		timeout: 5_000,
		maxBuffer: 1024 * 1024,
	});
	return { stdout: result.stdout, stderr: result.stderr };
};

/**
 * Establish and verify an owner-only DACL on `dirPath` on Windows.
 * Fails closed (`unsafe_windows_credentials_acl`) if inheritance cannot be
 * disabled or any non-owner/non-SYSTEM principal remains.
 */
export const enforceWindowsOwnerOnlyDacl = async (
	dirPath: string,
	runner: WindowsAclRunner = defaultRunner,
): Promise<void> => {
	let identity: { account: string; sid: string } | null = null;
	try {
		const { stdout } = await runner("whoami.exe", [
			"/user",
			"/fo",
			"csv",
			"/nh",
		]);
		identity = parseWhoamiUserCsv(stdout);
	} catch {
		throw new Error("unsafe_windows_credentials_acl: whoami_failed");
	}
	if (!identity) {
		throw new Error("unsafe_windows_credentials_acl: unknown_user_sid");
	}
	try {
		await runner("icacls.exe", [
			dirPath,
			"/inheritance:r",
			"/grant:r",
			`*${identity.sid}:(OI)(CI)F`,
			`*${SYSTEM_SID}:(OI)(CI)F`,
		]);
		const { stdout } = await runner("icacls.exe", [dirPath]);
		const verified = verifyIcaclsOwnerOnly(stdout, dirPath, [
			identity.account,
			`*${identity.sid}`,
			identity.sid,
		]);
		if (!verified.ok) {
			throw new Error(`unsafe_windows_credentials_acl: ${verified.reason}`);
		}
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("unsafe_windows_credentials_acl")
		) {
			throw error;
		}
		throw new Error("unsafe_windows_credentials_acl: icacls_failed");
	}
};

/**
 * Ensure the dedicated credentials directory exists with owner-only permissions:
 * - POSIX: mode 0o700
 * - Windows: owner-only DACL (inheritance disabled, current user + SYSTEM only)
 */
export const ensureCredentialsDirectory = async (
	credentialsDir: string,
	options?: { platform?: NodeJS.Platform; windowsRunner?: WindowsAclRunner },
): Promise<void> => {
	const platform = options?.platform ?? process.platform;
	await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
	if (platform === "win32") {
		await enforceWindowsOwnerOnlyDacl(credentialsDir, options?.windowsRunner);
		return;
	}
	await fs.chmod(credentialsDir, 0o700);
};
