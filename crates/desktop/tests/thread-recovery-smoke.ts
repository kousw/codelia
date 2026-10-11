/** Real runtime/provider, two temporary Git worktrees and a restart. Never paid. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type {
	InitializeResult,
	RunStartParams,
	RunStartResult,
	SessionListResult,
	WorktreeCreateResult,
	WorktreeListResult,
} from "@codelia/protocol";

const repo = resolve(import.meta.dir, "../../..");
const fixture = await realpath(
	await mkdtemp(resolve(tmpdir(), "codelia-thread-recovery-")),
);
const provider = spawn(
	process.execPath,
	[resolve(import.meta.dir, "local-provider.ts"), fixture],
	{ cwd: repo, stdio: "ignore" },
);
const clients: Client[] = [];
let baseUrl = "";
const wait = async (condition: () => boolean) => {
	for (let n = 0; n < 160; n++) {
		if (condition()) return;
		await Bun.sleep(50);
	}
	throw new Error("Fixture wait timed out");
};
class Client {
	readonly child;
	readonly statuses = new Map<string, string>();
	confirmations = 0;
	private count = 0;
	private readonly pending = new Map<
		string,
		{ resolve(value: unknown): void; reject(error: Error): void }
	>();
	constructor(readonly root: string) {
		this.child = spawn(
			process.execPath,
			[resolve(repo, "packages/runtime/src/index.ts")],
			{
				cwd: root,
				stdio: ["pipe", "pipe", "ignore"],
				env: {
					...process.env,
					OPENAI_API_KEY: "fixture-not-a-secret",
					OPENAI_BASE_URL: baseUrl,
					CODELIA_LAYOUT: "xdg",
					XDG_CONFIG_HOME: resolve(fixture, "config"),
					XDG_CACHE_HOME: resolve(fixture, "cache"),
					XDG_STATE_HOME: resolve(fixture, "state"),
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
				},
			},
		);
		clients.push(this);
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			try {
				const msg = JSON.parse(line);
				if (msg.method === "ui.confirm.request") {
					this.confirmations++;
					assert.equal(msg.params.title, "Create worktree");
					this.write({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
				} else if (msg.method === "run.status")
					this.statuses.set(msg.params.run_id, msg.params.status);
				else if (!msg.method) {
					const pending = this.pending.get(msg.id);
					this.pending.delete(msg.id);
					if (msg.error) pending?.reject(new Error(msg.error.message));
					else pending?.resolve(msg.result);
				}
			} catch (error) {
				for (const pending of this.pending.values())
					pending.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
				this.pending.clear();
			}
		});
	}
	private write(msg: unknown) {
		this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}
	rpc<T>(method: string, params: unknown = {}): Promise<T> {
		return new Promise((resolveValue, reject) => {
			const id = `recovery-${++this.count}`;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, 8000);
			this.pending.set(id, {
				resolve(value) {
					clearTimeout(timer);
					resolveValue(value as T);
				},
				reject(error) {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}
	async init() {
		const result = await this.rpc<InitializeResult>("initialize", {
			protocol_version: "0",
			client: { name: "codelia-thread-recovery-smoke", version: "0" },
			ui_capabilities: {
				supports_confirm: true,
				supports_ui_request_cancel: true,
			},
		});
		assert.equal(result.server_capabilities?.supports_new_session, true);
		assert.equal(result.server_capabilities?.supports_workspace_identity, true);
		return this.rpc<WorktreeListResult>("worktree.list");
	}
	async run(params: RunStartParams) {
		const result = await this.rpc<RunStartResult>("run.start", {
			...params,
			ui_context: { cwd: this.root, workspace_root: this.root },
		});
		await wait(() =>
			["completed", "error", "cancelled"].includes(
				this.statuses.get(result.run_id) ?? "",
			),
		);
		assert.equal(this.statuses.get(result.run_id), "completed");
		assert(result.session_id);
		return result as RunStartResult & { session_id: string };
	}
	async close() {
		if (this.child.exitCode !== null) return;
		this.child.stdin.end();
		await wait(() => this.child.exitCode !== null);
	}
}
const probes = async () =>
	(await readFile(resolve(fixture, "thread-probes.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
let failure: unknown;
try {
	await wait(() => existsSync(resolve(fixture, "provider.json")));
	baseUrl = JSON.parse(
		await readFile(resolve(fixture, "provider.json"), "utf8"),
	).url;
	const root = resolve(fixture, "workspace");
	const git = async (...args: string[]) =>
		promisify(execFile)("git", ["-C", root, ...args], {
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
			},
		});
	await git("init", "-b", "main");
	await git("config", "user.name", "Codelia fixture");
	await git("config", "user.email", "fixture@localhost.invalid");
	await git("add", "README.md");
	await git("-c", "core.hooksPath=/dev/null", "commit", "-m", "Fixture base");
	await writeFile(resolve(root, "README.md"), "Unsent 日本語 source edits\n");
	const a = new Client(root);
	const identityA = await a.init();
	const workspaceA = {
		project_id: identityA.project_id,
		checkout_id: identityA.checkout_id,
		root,
	};
	const first = await a.run({
		input: { type: "text", text: "native-smoke:thread-first" },
		new_session: true,
		workspace_identity: workspaceA,
	});
	const second = await a.run({
		input: { type: "text", text: "native-smoke:thread-second" },
		new_session: true,
		workspace_identity: workspaceA,
	});
	assert.notEqual(first.session_id, second.session_id);
	assert.deepEqual((await probes())[1], {
		first: false,
		second: true,
		other: false,
		followup: false,
	});
	await a.run({
		input: { type: "text", text: "native-smoke:thread-followup" },
		session_id: first.session_id,
		workspace_identity: workspaceA,
	});
	assert.deepEqual((await probes())[2], {
		first: true,
		second: false,
		other: false,
		followup: true,
	});
	const intent = {
		operation_id: "recovery-one",
		title: "Recovery",
		thread_id: first.session_id,
		base_ref: "HEAD",
	};
	const created = await a.rpc<WorktreeCreateResult>("worktree.create", intent);
	assert.equal(created.operation.phase, "ready");
	const b = new Client(created.operation.path);
	const identityB = await b.init();
	const workspaceB = {
		project_id: identityB.project_id,
		checkout_id: identityB.checkout_id,
		root: b.root,
	};
	assert.equal(identityB.project_id, identityA.project_id);
	assert.notEqual(identityB.checkout_id, identityA.checkout_id);
	assert.equal(
		(
			await b.rpc<SessionListResult>("session.list", {
				scope: "current_workspace",
			})
		).sessions.length,
		0,
	);
	await assert.rejects(
		b.run({
			input: { type: "text", text: "never" },
			session_id: first.session_id,
			workspace_identity: workspaceB,
		}),
		/another or replaced checkout/,
	);
	assert.equal(
		(await probes()).length,
		3,
		"foreign session rejects before any provider call",
	);
	await b.run({
		input: { type: "text", text: "native-smoke:thread-other" },
		new_session: true,
		workspace_identity: workspaceB,
	});
	assert.deepEqual((await probes())[3], {
		first: false,
		second: false,
		other: true,
		followup: false,
	});
	await a.close();
	const record = resolve(
		dirname(dirname(created.operation.path)),
		"operations",
		intent.operation_id,
		"record.json",
	);
	await writeFile(
		record,
		JSON.stringify({ ...created.operation, phase: "creating" }),
	);
	const restarted = new Client(root);
	const restored = await restarted.init();
	assert.equal(restored.operations[0].phase, "unknown");
	assert.equal(restored.operations[0].recorded_phase, "creating");
	assert.equal(
		(
			await restarted.rpc<SessionListResult>("session.list", {
				scope: "current_workspace",
			})
		).sessions.length,
		2,
	);
	const duplicate = await restarted.rpc<WorktreeCreateResult>(
		"worktree.create",
		intent,
	);
	assert.equal(duplicate.operation.phase, "unknown");
	assert.equal(restarted.confirmations, 0);
	assert.equal(
		(await probes()).length,
		4,
		"initialize/list/duplicate never replay model or create",
	);
	assert.equal(
		JSON.parse(await readFile(record, "utf8")).phase,
		"creating",
		"reconciliation is observational, not automatic completion",
	);
	await restarted.run({
		input: { type: "text", text: "native-smoke:thread-followup" },
		session_id: first.session_id,
		workspace_identity: workspaceA,
	});
	assert.deepEqual((await probes())[4], {
		first: true,
		second: false,
		other: false,
		followup: true,
	});
	assert.equal(
		await readFile(resolve(root, "README.md"), "utf8"),
		"Unsent 日本語 source edits\n",
	);
	console.log(
		`PASS: real loopback two-thread/two-worktree history isolation, foreign-session rejection before model work, restart recovery/unknown intent/no replay; fixture=${fixture}`,
	);
} catch (error) {
	failure = error;
} finally {
	for (const client of clients)
		try {
			await client.close();
		} catch (error) {
			failure ??= error;
		}
	await writeFile(resolve(fixture, "provider-stop"), "stop");
	try {
		await wait(() => provider.exitCode !== null);
	} catch (error) {
		failure ??= error;
	}
	if (!failure) await rm(fixture, { recursive: true, force: true });
}
if (failure) throw failure;
