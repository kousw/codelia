import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	authLockPathFor,
	DEFAULT_AUTH_LOCK_TIMEOUT_MS,
	DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
	withAuthStoreLock,
	writeFileAtomic,
} from "../src";

describe("atomic file writes and interprocess auth store lock", () => {
	let tempRoot = "";

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-auth-lock-"));
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	test("default lock wait budget exceeds OAuth refresh timeout", () => {
		expect(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS).toBe(30_000);
		expect(DEFAULT_AUTH_LOCK_TIMEOUT_MS).toBeGreaterThan(
			DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
		);
	});

	test("writeFileAtomic writes 0600 files without leaving temp files behind", async () => {
		const target = path.join(tempRoot, "auth.json");
		await writeFileAtomic(target, JSON.stringify({ version: 1 }));
		expect(await fs.readFile(target, "utf8")).toBe('{"version":1}');
		if (process.platform !== "win32") {
			const stat = await fs.stat(target);
			expect(stat.mode & 0o777).toBe(0o600);
		}
		const entries = await fs.readdir(tempRoot);
		expect(entries).toEqual(["auth.json"]);
	});

	test("withAuthStoreLock serializes updates across separate OS processes", async () => {
		const configDir = path.join(tempRoot, "config");
		const credentialsDir = path.join(configDir, "credentials");
		await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
		const mcpFile = path.join(credentialsDir, "mcp-auth.json");
		const workerScript = path.join(tempRoot, "worker.ts");
		await fs.writeFile(
			workerScript,
			`
import { McpAuthStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/mcp-auth-store.ts"))};
const serverId = process.argv[2];
const paths = {
	root: ${JSON.stringify(configDir)},
	configDir: ${JSON.stringify(configDir)},
	credentialsDir: ${JSON.stringify(credentialsDir)},
	cacheDir: ${JSON.stringify(configDir)},
	stateDir: ${JSON.stringify(configDir)},
	configFile: ${JSON.stringify(path.join(configDir, "config.json"))},
	projectsFile: ${JSON.stringify(path.join(configDir, "projects.json"))},
	authFile: ${JSON.stringify(path.join(credentialsDir, "auth.json"))},
	mcpAuthFile: ${JSON.stringify(mcpFile)},
	legacyAuthFile: ${JSON.stringify(path.join(configDir, "auth.json"))},
	legacyMcpAuthFile: ${JSON.stringify(path.join(configDir, "mcp-auth.json"))},
	authStateFile: ${JSON.stringify(path.join(credentialsDir, "storage-state.json"))},
	sessionsDir: ${JSON.stringify(configDir)},
	toolOutputCacheDir: ${JSON.stringify(configDir)},
	logsDir: ${JSON.stringify(configDir)},
};
const store = new McpAuthStore(paths);
await store.update(async (auth) => {
	await Bun.sleep(40);
	auth.servers[serverId] = {
		binding: { resource_uri: "https://mcp.example.test/" + serverId },
		tokens: { access_token: "token-" + serverId },
	};
});
`,
			"utf8",
		);

		const runWorker = (id: string) =>
			new Promise<void>((resolve, reject) => {
				const child = spawn(process.execPath, ["run", workerScript, id], {
					stdio: "inherit",
				});
				child.once("error", reject);
				child.once("exit", (code) => {
					if (code === 0) resolve();
					else reject(new Error(`worker ${id} exited with code ${code}`));
				});
			});

		await Promise.all([
			runWorker("alpha"),
			runWorker("beta"),
			runWorker("gamma"),
		]);
		const finalDoc = JSON.parse(await fs.readFile(mcpFile, "utf8")) as {
			version: number;
			servers: Record<string, { tokens: { access_token: string } }>;
		};
		expect(finalDoc.version).toBe(2);
		expect(finalDoc.servers.alpha?.tokens.access_token).toBe("token-alpha");
		expect(finalDoc.servers.beta?.tokens.access_token).toBe("token-beta");
		expect(finalDoc.servers.gamma?.tokens.access_token).toBe("token-gamma");
	});

	test("withAuthStoreLock times out cleanly when another process holds the lock past deadline", async () => {
		const lockPath = authLockPathFor(tempRoot);
		const holderScript = path.join(tempRoot, "holder.ts");
		await fs.writeFile(
			holderScript,
			`
import { withAuthStoreLock } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/auth-lock.ts"))};
await withAuthStoreLock(${JSON.stringify(lockPath)}, async () => {
	console.log("LOCKED");
	await Bun.sleep(1500);
});
`,
			"utf8",
		);

		const child = spawn(process.execPath, ["run", holderScript], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		try {
			await new Promise<void>((resolve, reject) => {
				child.stdout.on("data", (chunk) => {
					if (String(chunk).includes("LOCKED")) resolve();
				});
				child.once("error", reject);
				child.once("exit", (code) => {
					reject(new Error(`holder exited early with ${code}`));
				});
			});

			await expect(
				withAuthStoreLock(lockPath, async () => "should-not-run", {
					timeoutMs: 120,
					pollMs: 15,
				}),
			).rejects.toThrow();
		} finally {
			child.kill("SIGKILL");
		}
	});
});
