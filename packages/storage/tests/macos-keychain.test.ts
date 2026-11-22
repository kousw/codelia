import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
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

		test("interactive authorization reads existing items without rewriting credentials", async () => {
			const writeLog = path.join(root, "writes.log");
			const client = await fixture(`
case "$1" in
  find-generic-password)
    if [ "$6" = "codelia.auth" ]; then
      printf '{"version":2,"providers":{}}\\n'
      exit 0
    fi
    printf 'The specified item could not be found in the keychain.\\n' >&2
    exit 44 ;;
  -i)
    : > "${writeLog}"
    exit 1 ;;
  *) exit 4 ;;
esac
`);

			expect(
				await client.authorize(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).toBe(true);
			expect(
				await client.authorize(CODELIA_MCP_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).toBe(false);
			await expect(fs.access(writeLog)).rejects.toMatchObject({
				code: "ENOENT",
			});
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

		test("a timed-out Keychain read explains how to authorize access locally", async () => {
			const client = await fixture("exec /bin/sleep 10");
			expect(() =>
				client.getSync(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT, 50),
			).toThrow(/timed out.*codelia auth authorize-keychain.*local terminal/);
			await expect(
				client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).rejects.toThrow(
				/timed out.*codelia auth authorize-keychain.*local terminal/,
			);
		}, 10_000);

		test("all synchronous lookups share the same timeout", async () => {
			const client = await fixture(`
/bin/sleep 0.10
case "$6" in
  codelia.auth) printf 'cb2:a:2\\n' ;;
  codelia.auth#g:a:0) printf 'cb1:2:eyJ2' ;;
  codelia.auth#g:a:1) printf 'cb1:2:ZXJzaW9uIjoyfQ==' ;;
  *) exit 44 ;;
esac
`);
			expect(() =>
				client.getSync(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT, 250),
			).toThrow(/timed out/);
		});

		test("a missing chunk from a superseded slot retries the current snapshot", async () => {
			const switched = path.join(root, "switched");
			const expected = '{"version":2}';
			const digest = createHash("sha256").update(expected).digest("hex");
			const client = await fixture(`
case "$6" in
  codelia.auth)
    if [ -e "${switched}" ]; then
      printf 'cb2:b:2.${digest}\\n'
    else
      printf 'cb2:a:2\\n'
    fi ;;
  codelia.auth#g:a:0) printf 'cb1:2:eyJ2' ;;
  codelia.auth#g:a:1) : > "${switched}"; exit 44 ;;
  codelia.auth#g:b:0) printf 'cb1:2:eyJ2' ;;
  codelia.auth#g:b:1) printf 'cb1:2:ZXJzaW9uIjoyfQ==' ;;
  *) exit 44 ;;
esac
`);
			expect(client.getSync(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT)).toBe(
				expected,
			);
			await fs.unlink(switched);
			await expect(
				client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).resolves.toBe(expected);
		});

		test("a reused slot does not return mixed chunks under the same pointer", async () => {
			const digest = createHash("sha256").update('{"version":2}').digest("hex");
			const client = await fixture(`
case "$6" in
  codelia.auth) printf 'cb2:a:2.${digest}\\n' ;;
  codelia.auth#g:a:0) printf 'cb1:2:eyJ2' ;;
  codelia.auth#g:a:1) printf 'cb1:2:ZXJzaW9uIjozfQ==' ;;
  *) exit 44 ;;
esac
`);
			expect(() =>
				client.getSync(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).toThrow("Inconsistent Keychain payload");
		});

		test("a malformed snapshot digest is rejected before fetching chunks", async () => {
			const client = await fixture(`
case "$6" in
  codelia.auth) printf 'cb2:a:2.invalid\\n' ;;
  *) exit 44 ;;
esac
`);
			expect(() =>
				client.getSync(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).toThrow("Corrupt Keychain generation pointer metadata");
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
