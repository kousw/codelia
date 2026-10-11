/** Real stdio runtime + temporary Git repo; no model server/request or native app. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type {
	InitializeResult,
	WorktreeCreateResult,
	WorktreeListResult,
} from "@codelia/protocol";

const exec = promisify(execFile);
const repo = resolve(import.meta.dir, "../../..");
const fixture = await realpath(
	await mkdtemp(resolve(tmpdir(), "codelia-worktree-rpc-")),
);
const workspace = resolve(fixture, "workspace");
await mkdir(workspace);
const git = async (...args: string[]) =>
	exec("git", ["-C", workspace, ...args], {
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	});
await git("init", "-b", "main");
await git("config", "user.name", "Codelia fixture");
await git("config", "user.email", "fixture@localhost.invalid");
await writeFile(resolve(workspace, "source.txt"), "committed\n");
await git("add", "source.txt");
await git("-c", "core.hooksPath=/dev/null", "commit", "-m", "Fixture base");
await writeFile(resolve(workspace, "source.txt"), "unsent 日本語\n");
await mkdir(resolve(fixture, "config/codelia"), { recursive: true });
await writeFile(
	resolve(fixture, "config/codelia/config.json"),
	JSON.stringify({ model: { provider: "openai", name: "gpt-6.1-sol" } }),
);
const runtime = spawn(
	process.execPath,
	[resolve(repo, "packages/runtime/src/index.ts")],
	{
		cwd: workspace,
		stdio: ["pipe", "pipe", "ignore"],
		env: {
			...process.env,
			OPENAI_API_KEY: "fixture-not-a-secret",
			OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
			CODELIA_LAYOUT: "xdg",
			XDG_CONFIG_HOME: resolve(fixture, "config"),
			XDG_CACHE_HOME: resolve(fixture, "cache"),
			XDG_STATE_HOME: resolve(fixture, "state"),
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	},
);
let counter = 0;
let approvals = 0;
let allow = false;
const pending = new Map<
	string,
	{ resolve(value: unknown): void; reject(error: Error): void }
>();
const write = (value: unknown) =>
	runtime.stdin.write(`${JSON.stringify(value)}\n`);
const rpc = <T>(method: string, params: unknown = {}) =>
	new Promise<T>((resolveValue, reject) => {
		const id = `worktree-smoke-${++counter}`;
		const timeout = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, 8_000);
		pending.set(id, {
			resolve(value) {
				clearTimeout(timeout);
				resolveValue(value as T);
			},
			reject(error) {
				clearTimeout(timeout);
				reject(error);
			},
		});
		write({ jsonrpc: "2.0", id, method, params });
	});
let failure: unknown;
createInterface({ input: runtime.stdout }).on("line", (line) => {
	try {
		const message = JSON.parse(line);
		if (message.method === "ui.confirm.request") {
			approvals++;
			assert.equal(message.params.allow_remember, false);
			assert.equal(message.params.worktree.actor, "user");
			assert.equal(message.params.worktree.thread_id, "native-thread");
			assert(message.params.message.includes("Committed base: HEAD"));
			write({ jsonrpc: "2.0", id: message.id, result: { ok: allow } });
		} else if (!message.method) {
			const waiter = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) waiter?.reject(new Error(message.error.message));
			else waiter?.resolve(message.result);
		}
	} catch (error) {
		failure = error;
		for (const waiter of pending.values())
			waiter.reject(error instanceof Error ? error : new Error(String(error)));
		pending.clear();
	}
});
try {
	const init = await rpc<InitializeResult>("initialize", {
		protocol_version: "0",
		client: { name: "codelia-worktree-smoke", version: "0" },
		ui_capabilities: {
			supports_confirm: true,
			supports_ui_request_cancel: true,
		},
	});
	assert.equal(init.server_capabilities?.supports_worktrees, true);
	const initial = await rpc<WorktreeListResult>("worktree.list");
	assert.equal(initial.current_path, workspace);
	assert.equal(initial.worktrees[0].dirty, true);
	const intent = {
		operation_id: "native-one",
		title: "Native test",
		thread_id: "native-thread",
		base_ref: "HEAD",
	};
	const denied = await rpc<WorktreeCreateResult>("worktree.create", intent);
	assert.equal(denied.operation.phase, "cancelled");
	allow = true;
	const created = await rpc<WorktreeCreateResult>("worktree.create", {
		...intent,
		operation_id: "native-two",
	});
	assert.equal(created.operation.phase, "ready");
	assert.equal(created.worktree?.dirty, false);
	assert.equal(approvals, 2);
	const repeated = await rpc<WorktreeCreateResult>("worktree.create", {
		...intent,
		operation_id: "native-two",
	});
	assert.equal(repeated.operation.path, created.operation.path);
	assert.equal(approvals, 2);
	assert.equal(
		await readFile(resolve(workspace, "source.txt"), "utf8"),
		"unsent 日本語\n",
	);
	assert.equal(
		await readFile(resolve(created.operation.path, "source.txt"), "utf8"),
		"committed\n",
	);
	await rename(created.operation.path, `${created.operation.path}-preserved`);
	const missing = await rpc<WorktreeListResult>("worktree.list");
	assert.equal(
		missing.worktrees.find((item) => item.path === created.operation.path)
			?.available,
		false,
	);
	console.log(
		`PASS: real runtime worktree RPC: exact approval/deny, committed-base creation, dirty-source preservation, duplicate and missing status; fixture=${fixture}; runtime=${runtime.pid}`,
	);
} catch (error) {
	failure = error;
} finally {
	runtime.stdin.end();
	for (let n = 0; n < 160 && runtime.exitCode === null; n++)
		await Bun.sleep(50);
	if (runtime.exitCode === null)
		failure ??= new Error(
			`Owned runtime did not exit via stdin EOF; fixture retained: ${fixture}`,
		);
	else await rm(fixture, { recursive: true, force: true });
}
if (failure) throw failure;
