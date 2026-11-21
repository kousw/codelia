import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
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
 * Resolve trusted absolute Windows system directory (`%SystemRoot%\System32`).
 * Rejects relative or non-drive-qualified values so bare executable lookups
 * can never resolve against cwd or attacker-controlled PATH entries.
 */
export const resolveWindowsSystem32Dir = (
	env: NodeJS.ProcessEnv = process.env,
): string => {
	const rawRoot = (env.SystemRoot ?? env.WINDIR ?? "").trim();
	const candidate = rawRoot || "C:\\Windows";
	if (!/^[A-Za-z]:\\/u.test(candidate) || candidate.includes("..")) {
		throw new Error("unsafe_windows_credentials_acl: invalid_system_root");
	}
	return path.win32.join(candidate, "System32");
};

export const resolveWindowsAclTools = (
	env: NodeJS.ProcessEnv = process.env,
): {
	system32Dir: string;
	whoamiExe: string;
	icaclsExe: string;
	powershellExe: string;
} => {
	const system32Dir = resolveWindowsSystem32Dir(env);
	return {
		system32Dir,
		whoamiExe: path.win32.join(system32Dir, "whoami.exe"),
		icaclsExe: path.win32.join(system32Dir, "icacls.exe"),
		powershellExe: path.win32.join(
			system32Dir,
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		),
	};
};

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

export const parseWindowsDirectoryOwnerProbe = (
	output: string,
): { ownerSid: string; isReparsePoint: boolean } | null => {
	const line = output
		.split(/\r?\n/u)
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	if (!line) return null;
	const match = /^(S-1-[0-9-]+)\|(true|false)$/iu.exec(line);
	if (!match) return null;
	return {
		ownerSid: match[1],
		isReparsePoint: match[2].toLowerCase() === "true",
	};
};

export type WindowsAclRunnerOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
};

export type WindowsAclRunner = (
	file: string,
	args: readonly string[],
	options?: WindowsAclRunnerOptions,
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: WindowsAclRunner = async (file, args, options) => {
	const result = await execFileAsync(file, [...args], {
		cwd: options?.cwd,
		env: options?.env,
		windowsHide: true,
		timeout: 5_000,
		maxBuffer: 1024 * 1024,
	});
	return { stdout: result.stdout, stderr: result.stderr };
};

const OWNER_PROBE_SCRIPT = [
	"$ErrorActionPreference='Stop';",
	"$p=$env:CODELIA_ACL_TARGET;",
	"$item=Get-Item -LiteralPath $p -Force;",
	"$reparse=([bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)).ToString().ToLowerInvariant();",
	"$sid=(Get-Acl -LiteralPath $p).GetOwner([System.Security.Principal.SecurityIdentifier]).Value;",
	'Write-Output "$sid|$reparse"',
].join(" ");

const verifyDirectoryOwner = async (
	dirPath: string,
	expectedSid: string,
	tools: ReturnType<typeof resolveWindowsAclTools>,
	runner: WindowsAclRunner,
): Promise<void> => {
	let probe: { ownerSid: string; isReparsePoint: boolean } | null = null;
	try {
		const { stdout } = await runner(
			tools.powershellExe,
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				OWNER_PROBE_SCRIPT,
			],
			{
				cwd: tools.system32Dir,
				env: {
					...process.env,
					CODELIA_ACL_TARGET: dirPath,
				},
			},
		);
		probe = parseWindowsDirectoryOwnerProbe(stdout);
	} catch {
		throw new Error("unsafe_windows_credentials_acl: owner_check_failed");
	}
	if (!probe) {
		throw new Error("unsafe_windows_credentials_acl: unparseable_owner_sid");
	}
	if (probe.isReparsePoint) {
		throw new Error("unsafe_windows_credentials_acl: reparse_point");
	}
	if (probe.ownerSid.toLowerCase() !== expectedSid.toLowerCase()) {
		throw new Error("unsafe_windows_credentials_acl: owner_mismatch");
	}
};

/**
 * Establish and verify an owner-only DACL on `dirPath` on Windows.
 * Uses strictly pinned absolute `%SystemRoot%\System32` binaries, verifies
 * directory ownership (SID) and absence of reparse points before and after
 * updating the DACL, and fails closed (`unsafe_windows_credentials_acl`) if
 * inheritance cannot be disabled or any non-owner/non-SYSTEM principal remains.
 */
export const enforceWindowsOwnerOnlyDacl = async (
	dirPath: string,
	runner: WindowsAclRunner = defaultRunner,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
	const tools = resolveWindowsAclTools(env);
	let identity: { account: string; sid: string } | null = null;
	try {
		const { stdout } = await runner(
			tools.whoamiExe,
			["/user", "/fo", "csv", "/nh"],
			{ cwd: tools.system32Dir },
		);
		identity = parseWhoamiUserCsv(stdout);
	} catch {
		throw new Error("unsafe_windows_credentials_acl: whoami_failed");
	}
	if (!identity) {
		throw new Error("unsafe_windows_credentials_acl: unknown_user_sid");
	}

	// Verify directory owner SID & non-reparse before mutating DACL so a
	// directory pre-created by another user is rejected immediately.
	await verifyDirectoryOwner(dirPath, identity.sid, tools, runner);

	try {
		await runner(
			tools.icaclsExe,
			[
				dirPath,
				"/inheritance:r",
				"/grant:r",
				`*${identity.sid}:(OI)(CI)F`,
				`*${SYSTEM_SID}:(OI)(CI)F`,
			],
			{ cwd: tools.system32Dir },
		);
		const { stdout } = await runner(tools.icaclsExe, [dirPath], {
			cwd: tools.system32Dir,
		});
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

	// Re-verify owner SID after DACL update.
	await verifyDirectoryOwner(dirPath, identity.sid, tools, runner);
};

/**
 * Ensure the dedicated credentials directory exists with owner-only permissions:
 * - POSIX: mode 0o700
 * - Windows: verified owner SID + owner-only DACL (inheritance disabled, current user + SYSTEM only)
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
