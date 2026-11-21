import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CredentialConflictError,
	readAuthStorageState,
	runTwoPhaseMigration,
} from "../src/credential-migration";

describe("two-phase credential migration state machine", () => {
	let tempRoot = "";

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-mig-"));
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	test("writes migrating state before destination writes and commits steady after both stores verify", async () => {
		const stateFile = path.join(tempRoot, "storage-state.json");
		const observedStates: string[] = [];
		let authDest: Record<string, unknown> | null = null;
		let mcpDest: Record<string, unknown> | null = null;
		let authCleaned = false;
		let mcpCleaned = false;

		const result = await runTwoPhaseMigration({
			stateFile,
			fromBackend: "file",
			toBackend: "keyring",
			authSlot: {
				name: "auth",
				readSource: async () => ({
					present: true,
					normalized: {
						version: 2,
						providers: { openai: { chat_method: "oauth" } },
					},
					nonEmpty: true,
				}),
				readDest: async () => ({
					present: false,
					normalized: { version: 2, providers: {} },
					nonEmpty: false,
				}),
				writeDest: async (doc) => {
					const st = await readAuthStorageState(stateFile);
					observedStates.push(st?.status ?? "missing");
					authDest = doc as Record<string, unknown>;
				},
				verifyDest: async () => authDest !== null,
				cleanupSource: async () => {
					authCleaned = true;
				},
			},
			mcpSlot: {
				name: "mcp_auth",
				readSource: async () => ({
					present: true,
					normalized: { version: 2, servers: {} },
					nonEmpty: false,
					extraWarnings: ["legacy-srv"],
				}),
				readDest: async () => ({
					present: false,
					normalized: { version: 2, servers: {} },
					nonEmpty: false,
				}),
				writeDest: async (doc) => {
					const st = await readAuthStorageState(stateFile);
					observedStates.push(st?.status ?? "missing");
					mcpDest = doc as Record<string, unknown>;
				},
				verifyDest: async () => mcpDest !== null,
				cleanupSource: async () => {
					mcpCleaned = true;
				},
			},
		});

		expect(result.migrated).toBe(true);
		expect(result.mcpReauthRequired).toEqual(["legacy-srv"]);
		expect(observedStates).toEqual(["migrating", "migrating"]);
		expect(authCleaned).toBe(true);
		expect(mcpCleaned).toBe(true);
		expect(await readAuthStorageState(stateFile)).toEqual({
			version: 1,
			status: "steady",
			active_backend: "keyring",
			mcp_reauth_required: ["legacy-srv"],
		});
	});

	test("aborts before any write if either store has conflicting destination content", async () => {
		const stateFile = path.join(tempRoot, "storage-state.json");
		let wroteAnything = false;

		await expect(
			runTwoPhaseMigration({
				stateFile,
				fromBackend: "keyring",
				toBackend: "file",
				authSlot: {
					name: "auth",
					readSource: async () => ({
						present: true,
						normalized: { version: 2, providers: { a: 1 } },
						nonEmpty: true,
					}),
					readDest: async () => ({
						present: true,
						normalized: { version: 2, providers: { a: 2 } },
						nonEmpty: true,
					}),
					writeDest: async () => {
						wroteAnything = true;
					},
					verifyDest: async () => true,
					cleanupSource: async () => {
						wroteAnything = true;
					},
				},
				mcpSlot: {
					name: "mcp_auth",
					readSource: async () => ({
						present: false,
						normalized: { version: 2, servers: {} },
						nonEmpty: false,
					}),
					readDest: async () => ({
						present: false,
						normalized: { version: 2, servers: {} },
						nonEmpty: false,
					}),
					writeDest: async () => {
						wroteAnything = true;
					},
					verifyDest: async () => true,
					cleanupSource: async () => {},
				},
			}),
		).rejects.toBeInstanceOf(CredentialConflictError);

		expect(wroteAnything).toBe(false);
		expect(await readAuthStorageState(stateFile)).toBeNull();
	});
});
