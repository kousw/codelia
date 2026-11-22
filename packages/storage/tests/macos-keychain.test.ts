import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearStoreAcrossAllLocationsUnlocked } from "../src/credential-backend";
import {
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	MacOsKeychainClient,
} from "../src/macos-keychain";
import { mcpAuthStoreAdapter } from "../src/mcp-auth-store";
import { resolveStoragePaths } from "../src/paths";

const ACCOUNT = "codelia-0123456789abcdef";

describe.skipIf(process.platform !== "darwin")(
	"macOS Keychain /usr/bin/security transport",
	() => {
		let root: string;

		beforeEach(async () => {
			root = await fs.mkdtemp(
				path.join(os.tmpdir(), "codelia-keychain-fixture-"),
			);
		});

		afterEach(async () => {
			await fs.rm(root, { recursive: true, force: true });
		});

		const fixture = async (script: string) => {
			const securityPath = path.join(root, "fake-security");
			await fs.writeFile(securityPath, `#!/bin/sh\n${script}`, { mode: 0o700 });
			return new MacOsKeychainClient({ securityPath });
		};

		test("preload keeps reads, probes, and full logout off /usr/bin/security", async () => {
			const failIfCalled = () => {
				throw new Error("Unexpected /usr/bin/security subprocess");
			};
			const asyncExec = spyOn(childProcess, "execFile").mockImplementation(
				Object.assign(failIfCalled, { __promisify__: failIfCalled }),
			);
			const syncExec = spyOn(childProcess, "execFileSync").mockImplementation(
				failIfCalled,
			);
			const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
				failIfCalled,
			);
			try {
				const client = new MacOsKeychainClient({ credentialsDir: root });
				const paths = resolveStoragePaths({ rootOverride: root });
				await fs.mkdir(paths.credentialsDir, { mode: 0o700 });
				await fs.writeFile(paths.mcpAuthFile, '{"version":2,"servers":{}}', {
					mode: 0o600,
				});
				expect(process.env.CODELIA_AUTH_STORAGE).toBe("file");
				expect(await client.probe()).toEqual({
					available: false,
					reason: "keychain_unavailable",
					message: "macOS Keychain is disabled for tests",
				});
				await expect(
					client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
				).rejects.toMatchObject({
					code: "keychain_unavailable",
				});
				expect(() =>
					client.getSync(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
				).toThrow("macOS Keychain is disabled for tests");
				await clearStoreAcrossAllLocationsUnlocked({
					paths,
					adapter: mcpAuthStoreAdapter,
					keychain: client,
				});
				await expect(fs.access(paths.mcpAuthFile)).rejects.toMatchObject({
					code: "ENOENT",
				});
				expect(asyncExec).not.toHaveBeenCalled();
				expect(syncExec).not.toHaveBeenCalled();
				expect(spawnSpy).not.toHaveBeenCalled();
			} finally {
				spawnSpy.mockRestore();
				syncExec.mockRestore();
				asyncExec.mockRestore();
			}
		});

		test("interactive authorization reads existing items and re-saves via security -i", async () => {
			const writeLog = path.join(root, "writes.log");
			const stateFile = path.join(root, "auth-value.txt");
			await fs.writeFile(stateFile, '{"version":2,"providers":{}}');
			const client = await fixture(`
case "$1" in
  find-generic-password)
    if [ "$6" = "codelia.auth" ]; then
      /bin/cat "${stateFile}"
      printf '\\n'
      exit 0
    fi
    printf 'The specified item could not be found in the keychain.\\n' >&2
    exit 44 ;;
  -i)
    line=$(/bin/cat)
    printf '%s\\n' "$line" >> "${writeLog}"
    val=$(printf '%s' "$line" | /usr/bin/awk '{for (i=1;i<=NF;i++) if ($i=="-w") print $(i+1)}')
    printf '%s' "$val" > "${stateFile}"
    exit 0 ;;
  *) exit 4 ;;
esac
`);

			expect(
				await client.authorize(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).toBe(true);
			expect(
				await client.authorize(CODELIA_MCP_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).toBe(false);
			const logged = await fs.readFile(writeLog, "utf8");
			expect(logged).toContain(
				`add-generic-password -U -a ${ACCOUNT} -s ${CODELIA_AUTH_KEYCHAIN_SERVICE} -w cb1:1:`,
			);
		});

		test("a locked Keychain (36) and an item ACL denial (128) have distinct results", async () => {
			const client = await fixture(`
case "$1" in
  show-keychain-info)
    printf 'security: SecKeychainGetStatus: User interaction is not allowed.\\n' >&2
    exit 36 ;;
  find-generic-password)
    printf 'security: SecKeychainSearchCopyNext: User canceled the operation.\\n' >&2
    exit 128 ;;
  *) exit 4 ;;
esac
`);

			expect(await client.probe()).toMatchObject({ reason: "keychain_locked" });
			await expect(
				client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).rejects.toMatchObject({
				code: "keychain_access_denied",
				message: expect.stringContaining("codelia auth authorize-keychain"),
			});
		});

		test("failed subprocess diagnostics and unrecognized payloads do not expose raw output", async () => {
			const client = await fixture(`
case "$1" in
  find-generic-password)
    if [ "$6" = "codelia.auth" ]; then
      printf 'fixture-private-stderr\\n' >&2
      printf 'fixture-private-stdout\\n'
      exit 1
    fi
    printf 'fixture-private-malformed-secret\\n'
    exit 0 ;;
  *) exit 4 ;;
esac
`);

			await expect(
				client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).rejects.toMatchObject({
				code: "keychain_error",
				message: "macOS Keychain operation failed",
			});
			expect(() =>
				client.getSync(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).toThrow(/^macOS Keychain operation failed$/);
			await expect(
				client.get(CODELIA_MCP_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).rejects.toMatchObject({
				code: "keychain_error",
				message: "Keychain item contains unrecognized credential format",
			});
		});
	},
);
