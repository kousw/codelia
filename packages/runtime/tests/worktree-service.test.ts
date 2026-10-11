import { afterEach, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WorktreeCreateParams } from "@codelia/protocol";
import type { CommandRunner } from "../src/lanes/command";
import { createWorktreeHandlers } from "../src/rpc/worktree";
import { RuntimeState } from "../src/runtime-state";
import { WorktreeService } from "../src/worktrees/service";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
const runner: CommandRunner = async (command, args) =>
	exec(command, args, {
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
const request = (operation_id = "test-one"): WorktreeCreateParams => ({
	operation_id,
	title: "日本語 review",
	thread_id: "thread-one",
	base_ref: "HEAD",
});
async function fixture() {
	const root = await realpath(
		await mkdtemp(path.join(os.tmpdir(), "codelia-worktree-test-")),
	);
	roots.push(root);
	const repo = path.join(root, "repo");
	await mkdir(repo);
	const git = async (...args: string[]) =>
		(await runner("git", ["-C", repo, ...args])).stdout;
	await git("init", "-b", "main");
	await git("config", "user.name", "Codelia fixture");
	await git("config", "user.email", "fixture@localhost.invalid");
	await writeFile(path.join(repo, "source.txt"), "committed\n");
	await git("add", "source.txt");
	await git("-c", "core.hooksPath=/dev/null", "commit", "-m", "Fixture base");
	const storageRoot = path.join(root, "managed");
	const service = new WorktreeService(repo, { runner, storageRoot });
	return { root, repo, git, storageRoot, service };
}

test("create uses committed base, keeps dirty source/branch and records project/thread/worktree association", async () => {
	const f = await fixture();
	await writeFile(path.join(f.repo, "source.txt"), "dirty 日本語\n");
	await writeFile(path.join(f.repo, "unsent.txt"), "untracked");
	const head = await f.git("rev-parse", "HEAD");
	const before = await f.git("status", "--porcelain=v1");
	let scope = "";
	const result = await f.service.create(request(), async (op) => {
		scope = `${op.base_commit}:${op.thread_id}:${op.source_path}`;
		return true;
	});
	expect(result.operation.phase).toBe("ready");
	expect(result.worktree?.dirty).toBe(false);
	expect(scope).toBe(`${head.trim()}:thread-one:${f.repo}`);
	expect(
		await readFile(path.join(result.operation.path, "source.txt"), "utf8"),
	).toBe("committed\n");
	expect(
		await readFile(
			path.join(result.operation.path, "unsent.txt"),
			"utf8",
		).catch(() => null),
	).toBeNull();
	expect(await f.git("rev-parse", "HEAD")).toBe(head);
	expect((await f.git("branch", "--show-current")).trim()).toBe("main");
	expect(await f.git("status", "--porcelain=v1")).toBe(before);
	expect(await readFile(path.join(f.repo, "source.txt"), "utf8")).toBe(
		"dirty 日本語\n",
	);
	const list = await f.service.list();
	expect(list.worktrees).toHaveLength(2);
	expect(list.operations[0].thread_id).toBe("thread-one");
	const second = await new WorktreeService(result.operation.path, {
		runner,
		storageRoot: f.storageRoot,
	}).list();
	expect(second.project_id).toBe(list.project_id);
	expect(second.current_path).toBe(result.operation.path);
});

test("concurrent duplicate and restart reuse one operation; changed payload is rejected", async () => {
	const f = await fixture();
	let entered!: () => void;
	let release!: (yes: boolean) => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const pending = f.service.create(request(), async () => {
		entered();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	await started;
	const other = new WorktreeService(f.repo, {
		runner,
		storageRoot: f.storageRoot,
	});
	const duplicate = await other.create(request(), async () => {
		throw new Error("Must not ask twice");
	});
	expect(duplicate.operation.phase).toBe("unknown");
	expect(duplicate.operation.recorded_phase).toBe("awaiting_confirmation");
	expect((await f.service.list()).worktrees).toHaveLength(1);
	release(true);
	const completed = await pending;
	const repeat = await other.create(request(), async () => {
		throw new Error("Must not ask again");
	});
	expect(repeat.operation.path).toBe(completed.operation.path);
	expect(repeat.operation.phase).toBe("ready");
	await expect(
		other.create({ ...request(), title: "different" }, async () => true),
	).rejects.toThrow("different worktree request");
	expect((await f.service.list()).worktrees).toHaveLength(2);
});

test("missing registered worktree is unavailable and duplicate never recreates it", async () => {
	const f = await fixture();
	const created = await f.service.create(request(), async () => true);
	await rename(created.operation.path, `${created.operation.path}-preserved`);
	const result = await f.service.create(request(), async () => {
		throw new Error("No replay");
	});
	expect(result.worktree?.available).toBe(false);
	expect(result.worktree?.dirty).toBeNull();
	expect(result.worktree?.error).toContain("missing");
	expect(result.worktree?.prunable).toBe(true);
});

test("creation failure keeps registered branch/path and is never silently replayed", async () => {
	const f = await fixture();
	let checkouts = 0;
	const failing: CommandRunner = async (command, args, opts) => {
		if (args.includes("read-tree")) {
			checkouts++;
			throw new Error("Fixture checkout failure");
		}
		return runner(command, args, opts);
	};
	const service = new WorktreeService(f.repo, {
		runner: failing,
		storageRoot: f.storageRoot,
	});
	const failed = await service.create(request(), async () => true);
	expect(failed.operation.phase).toBe("failed");
	expect(failed.worktree?.available).toBe(true);
	await writeFile(
		path.join(failed.operation.path, "preserve.txt"),
		"user edits after failure",
	);
	const repeat = await f.service.create(request(), async () => true);
	expect(repeat.operation.phase).toBe("failed");
	expect(checkouts).toBe(1);
	expect(
		await readFile(path.join(failed.operation.path, "preserve.txt"), "utf8"),
	).toBe("user edits after failure");
	expect(
		(
			await f.git(
				"for-each-ref",
				"--format=%(refname:short)",
				`refs/heads/${failed.operation.branch}`,
			)
		).trim(),
	).toBe(failed.operation.branch);
});

test("denial, invalid refs and traversal cannot create Git worktrees", async () => {
	const f = await fixture();
	const denied = await f.service.create(request(), async () => false);
	expect(denied.operation.phase).toBe("cancelled");
	expect(
		(await f.service.create(request(), async () => true)).operation.phase,
	).toBe("cancelled");
	await expect(
		f.service.create(
			{ ...request("bad-base"), base_ref: "missing-ref" },
			async () => true,
		),
	).rejects.toThrow();
	await expect(
		f.service.create(request("../escape"), async () => true),
	).rejects.toThrow("stable operation ID");
	await expect(
		f.service.create(
			{ ...request("options"), base_ref: "--detach" },
			async () => true,
		),
	).rejects.toThrow("Invalid base ref");
	expect((await f.service.list()).worktrees).toHaveLength(1);
});

test("configured checkout scripts are rejected and Git hooks are not executed", async () => {
	const f = await fixture();
	const marker = path.join(f.root, "hook-ran");
	await writeFile(
		path.join(f.repo, ".git", "hooks", "post-checkout"),
		`#!/bin/sh\ntouch '${marker}'\n`,
		{ mode: 0o755 },
	);
	expect(
		(await f.service.create(request(), async () => true)).operation.phase,
	).toBe("ready");
	expect(await readFile(marker).catch(() => null)).toBeNull();
	await f.git("config", "filter.fixture.smudge", `touch '${marker}'`);
	await expect(
		f.service.create(request("filter"), async () => true),
	).rejects.toThrow("checkout filters");
	const current = (await f.service.list()).worktrees.find(
		(item) => item.current,
	);
	expect(current?.dirty).toBeNull();
	expect(current?.error).toContain("filters");
	expect(await readFile(marker).catch(() => null)).toBeNull();
});

test("RPC creation requires exact UI approval; cancelled parent cannot approve late or escape parameters", async () => {
	const f = await fixture();
	const state = new RuntimeState();
	state.runtimeWorkingDir = f.repo;
	state.setUiCapabilities({
		supports_confirm: true,
		supports_ui_request_cancel: true,
	});
	const abort = new AbortController();
	state.beginRun("parent");
	state.activeRunSignal = abort.signal;
	const handler = createWorktreeHandlers(state, f.service);
	const sent: Array<{
		id?: string;
		method?: string;
		params?: { message: string; allow_remember: boolean };
		result?: { operation: { phase: string } };
		error?: unknown;
	}> = [];
	const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		sent.push(JSON.parse(String(chunk)));
		return true;
	});
	try {
		const pending = handler.create("create-cancel", {
			...request(),
			run_id: "parent",
		});
		for (
			let n = 0;
			n < 100 && !sent.some((item) => item.method === "ui.confirm.request");
			n++
		)
			await Bun.sleep(10);
		const confirmation = sent.find(
			(item) => item.method === "ui.confirm.request",
		);
		expect(confirmation?.params?.message).toContain("Thread: thread-one");
		expect(confirmation?.params?.message).toContain("Committed base: HEAD");
		expect(confirmation?.params?.message).toContain(
			"codelia/worktree/test-one",
		);
		expect(confirmation?.params?.allow_remember).toBe(false);
		abort.abort();
		await pending;
		expect(
			sent.find((item) => item.id === "create-cancel")?.result?.operation.phase,
		).toBe("cancelled");
		expect(sent.some((item) => item.method === "ui.request.cancel")).toBe(true);
		expect(
			state.resolveUiResponse({
				jsonrpc: "2.0",
				id: confirmation?.id ?? "missing",
				result: { ok: true },
			}),
		).toBe(false);
		expect((await f.service.list()).worktrees).toHaveLength(1);
		await handler.create("old-run", { ...request("second"), run_id: "old" });
		await handler.create("escape", {
			...request("second"),
			destination: "/arbitrary",
		});
		expect(sent.find((item) => item.id === "old-run")?.error).toBeDefined();
		expect(sent.find((item) => item.id === "escape")?.error).toBeDefined();
		state.finishRun("parent");
		state.beginRun("next-parent");
		state.activeRunSignal = new AbortController().signal;
		const approved = handler.create("create-approved", {
			...request("approved"),
			run_id: "next-parent",
		});
		for (
			let n = 0;
			n < 100 &&
			sent.filter((item) => item.method === "ui.confirm.request").length < 2;
			n++
		)
			await Bun.sleep(10);
		const next = sent.filter((item) => item.method === "ui.confirm.request")[1];
		expect(next?.id).toBeDefined();
		// Normal completion preserves the admitted exact intent; Stop above does not.
		state.finishRun("next-parent");
		state.resolveUiResponse({
			jsonrpc: "2.0",
			id: next?.id ?? "missing",
			result: { ok: true },
		});
		await approved;
		expect(
			sent.find((item) => item.id === "create-approved")?.result?.operation
				.phase,
		).toBe("ready");
		expect((await f.service.list()).worktrees).toHaveLength(2);
	} finally {
		output.mockRestore();
	}
});

test("a replaced registered directory is never observed as a clean worktree in this project", async () => {
	const f = await fixture();
	const created = await f.service.create(request(), async () => true);
	await rename(created.operation.path, `${created.operation.path}-saved`);
	await mkdir(created.operation.path);
	await runner("git", ["-C", created.operation.path, "init", "-b", "foreign"]);
	const item = (await f.service.list()).worktrees.find(
		(item) => item.path === created.operation.path,
	);
	expect(item?.available).toBe(false);
	expect(item?.dirty).toBeNull();
	expect(item?.error).toContain("unavailable");
});

test("source repo replacement during confirmation cannot create in the replacement project", async () => {
	const f = await fixture();
	const other = await fixture();
	// Same commit content lets an incorrect foreign Git-add succeed: reject by project identity.
	await runner("git", ["-C", other.repo, "fetch", f.repo, "main"]);
	const base = (await f.git("rev-parse", "HEAD")).trim();
	const result = await f.service.create(
		{ ...request(), base_ref: base },
		async () => {
			await rename(f.repo, `${f.repo}-original`);
			await rename(other.repo, f.repo);
			return true;
		},
	);
	expect(result.operation.phase).toBe("failed");
	expect(
		(await runner("git", ["-C", f.repo, "worktree", "list", "--porcelain"]))
			.stdout,
	).not.toContain(result.operation.path);
	expect(
		await readFile(path.join(result.operation.path, "source.txt")).catch(
			() => null,
		),
	).toBeNull();
});

test("restarted pending intent and corrupt reservation report unknown without replaying Git", async () => {
	const f = await fixture();
	const made = await f.service.create(request(), async () => true);
	const project = (await f.service.list()).project_id;
	const record = path.join(
		f.storageRoot,
		project,
		"operations",
		made.operation.operation_id,
		"record.json",
	);
	await writeFile(
		record,
		JSON.stringify({ ...made.operation, phase: "creating" }),
	);
	const restarted = new WorktreeService(f.repo, {
		runner,
		storageRoot: f.storageRoot,
	});
	const list = await restarted.list();
	expect(list.operations[0].phase).toBe("unknown");
	expect(
		(
			await restarted.create(request(), async () => {
				throw new Error("Must not replay");
			})
		).operation.phase,
	).toBe("unknown");
	await writeFile(record, "{broken");
	const broken = await restarted.list();
	expect(broken.operations[0].phase).toBe("unknown");
	expect(broken.worktrees).toHaveLength(2);
	await expect(restarted.create(request(), async () => true)).rejects.toThrow(
		"record",
	);
	expect(await readFile(record, "utf8")).toBe("{broken");
});
