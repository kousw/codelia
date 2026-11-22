import { execFile, execFileSync } from "node:child_process";
import { promises as fs, lstatSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const resolveWindowsSystem32Dir = (
	env: NodeJS.ProcessEnv = process.env,
): string => {
	const root = (env.SystemRoot ?? env.WINDIR ?? "").trim() || "C:\\Windows";
	if (!/^[A-Za-z]:\\/u.test(root) || root.includes("..")) {
		throw new Error("unsafe_windows_credentials_acl: invalid_system_root");
	}
	return path.win32.join(root, "System32");
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

const execOptions = {
	windowsHide: true,
	timeout: 5_000,
	maxBuffer: 32 * 1024,
} as const;

const defaultRunner: WindowsAclRunner = async (exe, args, options) =>
	execFileAsync(exe, [...args], { ...options, ...execOptions });

// Windows PowerShell uses .NET directly so verification depends on security
// descriptors and SIDs, independent of localized command output or account names.
const aclScript = `
$ErrorActionPreference = 'Stop'
$target = $env:CODELIA_ACL_TARGET
$operation = $env:CODELIA_ACL_OPERATION
$legacy = $operation -eq 'legacy_file'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = 'S-1-5-32-544'
$sections = [System.Security.AccessControl.AccessControlSections]'Owner, Access'
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$inheritAces = [System.Security.AccessControl.AceFlags]'ContainerInherit, ObjectInherit'
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
# Include generic read and execute if Windows left the generic bits unmapped.
$legacyReadMask = (
  [int][System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
  [int][System.Security.AccessControl.FileSystemRights]::Synchronize -bor
  [int]::MinValue -bor 0x20000000
)

function Get-TargetType([string]$file, [bool]$directory) {
  try {
    $attributes = [System.IO.File]::GetAttributes($file)
  } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] {
    return 'missing'
  }
  if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { return 'reparse_point' }
  if ([bool]($attributes -band [System.IO.FileAttributes]::Directory) -ne $directory) {
    return 'unexpected_target_type'
  }
  return 'ok'
}

function Test-CredentialAcl($acl, [bool]$directory) {
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new(
    $acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($descriptor.Owner.Value -ne $user.Value) { return 'owner_mismatch' }
  if ($null -eq $descriptor.DiscretionaryAcl) { return 'null_dacl' }
  if ($directory -and -not $acl.AreAccessRulesProtected) { return 'unprotected_dacl' }
  $hasUser = $false
  foreach ($ace in $descriptor.DiscretionaryAcl) {
    if ($legacy -and ($ace.AceType -eq [System.Security.AccessControl.AceType]::AccessDenied -or
      $ace.AceFlags.HasFlag([System.Security.AccessControl.AceFlags]::InheritOnly))) { continue }
    if ($ace.AceType -ne [System.Security.AccessControl.AceType]::AccessAllowed) {
      return 'unexpected_ace_type'
    }
    $sid = $ace.SecurityIdentifier.Value
    if ($legacy) {
      # The old config root may have inherited Administrators and read grants.
      if ($sid -ne $user.Value -and $sid -ne $system.Value -and $sid -ne $administrators -and
        ($ace.AccessMask -band (-bnot $legacyReadMask))) { return 'legacy_write_grant' }
      continue
    }
    if ($sid -ne $user.Value -and $sid -ne $system.Value) { return 'unexpected_principals' }
    if ($directory -and ($ace.AccessMask -ne [int]$full -or $ace.AceFlags -ne $inheritAces)) {
      return 'unexpected_directory_ace'
    }
    if ($sid -eq $user.Value) { $hasUser = $true }
  }
  if (-not $legacy -and -not $hasUser) { return 'missing_user_grant' }
  return 'ok'
}

if ($operation -eq 'ensure_directory') {
  $targetType = Get-TargetType $target $true
  if ($targetType -ne 'ok') { $targetType; exit }
  $acl = [System.IO.Directory]::GetAccessControl($target, $sections)
  $result = Test-CredentialAcl $acl $true
  if ($result -eq 'ok' -or $result -eq 'owner_mismatch') { $result; exit }

  $privateAcl = [System.Security.AccessControl.DirectorySecurity]::new()
  $privateAcl.SetAccessRuleProtection($true, $false)
  $propagate = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $privateAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $user, $full, $inherit, $propagate, $allow))
  if ($user.Value -ne $system.Value) {
    $privateAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $system, $full, $inherit, $propagate, $allow))
  }
  [System.IO.Directory]::SetAccessControl($target, $privateAcl)
  $targetType = Get-TargetType $target $true
  if ($targetType -ne 'ok') { $targetType; exit }
  Test-CredentialAcl ([System.IO.Directory]::GetAccessControl($target, $sections)) $true
  exit
}

if ($operation -eq 'file') {
  $parent = [System.IO.Path]::GetDirectoryName($target)
  $parentType = Get-TargetType $parent $true
  if ($parentType -ne 'ok') { $parentType; exit }
  $parentAcl = Test-CredentialAcl ([System.IO.Directory]::GetAccessControl($parent, $sections)) $true
  if ($parentAcl -ne 'ok') { $parentAcl; exit }
}
try {
  $targetType = Get-TargetType $target $false
  if ($targetType -ne 'ok') { $targetType; exit }
  Test-CredentialAcl ([System.IO.File]::GetAccessControl($target, $sections)) $false
} catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] {
  'missing'
}
`;

type AclOperation = "ensure_directory" | "file" | "legacy_file";

const encodedAclScript = Buffer.from(aclScript, "utf16le").toString("base64");

function aclCommand(
	target: string,
	operation: AclOperation,
	env: NodeJS.ProcessEnv,
) {
	const system32 = resolveWindowsSystem32Dir(env);
	return {
		exe: path.win32.join(
			system32,
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		),
		args: [
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			encodedAclScript,
		],
		options: {
			cwd: system32,
			env: {
				...env,
				CODELIA_ACL_TARGET: path.win32.resolve(target),
				CODELIA_ACL_OPERATION: operation,
			},
		},
	};
}

const aclFailures = new Set([
	"missing",
	"owner_mismatch",
	"reparse_point",
	"unexpected_target_type",
	"null_dacl",
	"unprotected_dacl",
	"unexpected_ace_type",
	"unexpected_principals",
	"legacy_write_grant",
	"unexpected_directory_ace",
	"missing_user_grant",
]);

function verifyAclResult(stdout: string, operation: AclOperation): boolean {
	const result = stdout.trim();
	if (result === "ok") return true;
	if (operation !== "ensure_directory" && result === "missing") return false;
	const reason = aclFailures.has(result) ? result : "invalid_probe_result";
	throw new Error(`unsafe_windows_credentials_acl: ${reason}`);
}

async function runAclCommand(
	target: string,
	operation: AclOperation,
	runner: WindowsAclRunner,
	env: NodeJS.ProcessEnv,
): Promise<boolean> {
	const { exe, args, options } = aclCommand(target, operation, env);
	let stdout: string;
	try {
		({ stdout } = await runner(exe, args, options));
	} catch {
		throw new Error("unsafe_windows_credentials_acl: acl_probe_failed");
	}
	return verifyAclResult(stdout, operation);
}

export const enforceWindowsOwnerOnlyDacl = async (
	dirPath: string,
	runner: WindowsAclRunner = defaultRunner,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
	await runAclCommand(dirPath, "ensure_directory", runner, env);
};

const isMissing = (error: unknown): boolean =>
	(error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Verify a Windows credential read without creating or repairing files. */
export const verifyWindowsCredentialFileAcl = async (
	filePath: string,
	legacy = false,
): Promise<boolean> => {
	if (process.platform !== "win32") return true;
	try {
		await fs.lstat(filePath);
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
	return runAclCommand(
		filePath,
		legacy ? "legacy_file" : "file",
		defaultRunner,
		process.env,
	);
};

export const verifyWindowsCredentialFileAclSync = (
	filePath: string,
	legacy = false,
): boolean => {
	if (process.platform !== "win32") return true;
	try {
		lstatSync(filePath);
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
	const operation = legacy ? "legacy_file" : "file";
	const { exe, args, options } = aclCommand(filePath, operation, process.env);
	let stdout: string;
	try {
		stdout = execFileSync(exe, args, {
			...options,
			...execOptions,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		throw new Error("unsafe_windows_credentials_acl: acl_probe_failed");
	}
	return verifyAclResult(stdout, operation);
};

/** Secure the dedicated credential directory before creating any auth files. */
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
	const info = await fs.lstat(credentialsDir);
	if (!info.isDirectory() || info.uid !== process.geteuid?.()) {
		throw new Error("unsafe_credentials_directory");
	}
	if ((info.mode & 0o777) !== 0o700) await fs.chmod(credentialsDir, 0o700);
};
