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
	"macOS Keychain helper transport",
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
			const helperPath = path.join(root, "helper");
			await fs.writeFile(helperPath, `#!/bin/sh\n${script}`, { mode: 0o700 });
			return new MacOsKeychainClient({
				helperPath,
				untrustedRoots: [],
			});
		};

		test("preload keeps reads and full logout off the native helper even when a checkout binary can be resolved", async () => {
			const failIfCalled = () => {
				throw new Error("Unexpected native subprocess");
			};
			const asyncExec = spyOn(childProcess, "execFile").mockImplementation(
				Object.assign(failIfCalled, { __promisify__: failIfCalled }),
			);
			const syncExec = spyOn(childProcess, "execFileSync").mockImplementation(
				failIfCalled,
			);
			try {
				const client = new MacOsKeychainClient({
					credentialsDir: root,
					untrustedRoots: [],
				});
				const paths = resolveStoragePaths({ rootOverride: root });
				await fs.mkdir(paths.credentialsDir, { mode: 0o700 });
				await fs.writeFile(paths.mcpAuthFile, '{"version":2,"servers":{}}', {
					mode: 0o600,
				});
				expect(process.env.CODELIA_AUTH_STORAGE).toBe("file");
				expect(await client.probe()).toEqual({
					available: false,
					reason: "keychain_unavailable",
					message: "the native Keychain helper is disabled for tests",
				});
				await expect(
					client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
				).rejects.toMatchObject({
					code: "keychain_unavailable",
				});
				expect(() =>
					client.getSync(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
				).toThrow("the native Keychain helper is disabled for tests");
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
			} finally {
				syncExec.mockRestore();
				asyncExec.mockRestore();
			}
		});

		test("interactive authorization verifies persistent access from a fresh process", async () => {
			const client = await fixture(String.raw`
request=$(/bin/cat)
case "$request" in
  *'"op":"authorize"'*'"allow_prompt":true'*)
    printf '%s\n' '{"ok":true,"found":true,"authorized":true}' ;;
  *'"op":"authorize"'*'"service":"codelia.auth"'*'"allow_prompt":false'*)
    printf '%s\n' '{"ok":true,"found":true,"authorized":true}' ;;
  *'"op":"authorize"'*'"service":"codelia.mcp-auth"'*'"allow_prompt":false'*)
    printf '%s\n' '{"ok":false,"code":"access_denied"}' ;;
  *) exit 4 ;;
esac
`);

			expect(
				await client.authorize(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).toBe(true);
			await expect(
				client.authorize(CODELIA_MCP_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).rejects.toMatchObject({
				code: "keychain_access_denied",
				message: expect.stringContaining("Always Allow"),
			});
		});

		test("a locked Keychain and an item ACL denial have distinct results", async () => {
			const client = await fixture(String.raw`
request=$(/bin/cat)
case "$request" in
  *'"op":"probe"'*)
    printf '%s\n' '{"ok":false,"code":"locked"}' ;;
  *'"op":"get"'*)
    printf '%s\n' '{"ok":false,"code":"access_denied"}' ;;
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

		test("failed subprocess diagnostics and malformed JSON do not expose raw output", async () => {
			const client = await fixture(String.raw`
request=$(/bin/cat)
case "$request" in
  *'"service":"codelia.auth"'*)
    printf '%s\n' 'fixture-private-stderr' >&2
    printf '%s\n' '{"ok":true,"found":true,"value":"fixture-private-stdout"}'
    exit 1 ;;
  *) printf '%s\n' 'fixture-private-malformed-response' ;;
esac
`);

			await expect(
				client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).rejects.toMatchObject({
				message: "credential helper failed",
			});
			expect(() =>
				client.getSync(CODELIA_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).toThrow(/^credential helper failed$/);
			await expect(
				client.get(CODELIA_MCP_AUTH_KEYCHAIN_SERVICE, ACCOUNT),
			).rejects.toMatchObject({
				message: "credential helper returned an invalid response",
			});
		});
	},
);
