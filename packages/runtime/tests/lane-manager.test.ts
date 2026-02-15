import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaneManager, type LaneRecord } from "../src/lanes";
import type { CommandRunner } from "../src/lanes/command";
import { LaneRegistryStore } from "../src/lanes/registry";

type FakeState = {
	repoRoot: string;
	aliveSessions: Set<string>;
	launchCommands: string[];
};

const createFakeRunner = (state: FakeState): CommandRunner => {
	return async (command, args) => {
		if (command === "tmux" && args[0] === "-V") {
			return { stdout: "tmux 3.2a\n", stderr: "" };
		}
		if (command === "tmux" && args[0] === "new-session") {
			const idx = args.indexOf("-s");
			const name = idx >= 0 ? args[idx + 1] : "";
			if (!name) {
				throw new Error("tmux new-session failed (exit 1): missing name");
			}
			state.aliveSessions.add(name);
			return { stdout: "", stderr: "" };
		}
		if (command === "tmux" && args[0] === "has-session") {
			const idx = args.indexOf("-t");
			const target = idx >= 0 ? args[idx + 1] : "";
			if (!state.aliveSessions.has(target)) {
				throw new Error(`tmux has-session failed (exit 1): ${target}`);
			}
			return { stdout: "", stderr: "" };
		}
		if (command === "tmux" && args[0] === "kill-session") {
			const idx = args.indexOf("-t");
			const target = idx >= 0 ? args[idx + 1] : "";
			state.aliveSessions.delete(target);
			return { stdout: "", stderr: "" };
		}
		if (command === "tmux" && args[0] === "send-keys") {
			const literalIndex = args.indexOf("-l");
			if (literalIndex >= 0 && literalIndex + 1 < args.length) {
				state.launchCommands.push(args[literalIndex + 1]);
			}
			return { stdout: "", stderr: "" };
		}
		if (
			command === "git" &&
			args[2] === "rev-parse" &&
			args[3] === "--show-toplevel"
		) {
			return { stdout: `${state.repoRoot}\n`, stderr: "" };
		}
		if (command === "git" && args[2] === "worktree" && args[3] === "add") {
			const worktreePath = args[6];
			await fs.mkdir(worktreePath, { recursive: true });
			return { stdout: "", stderr: "" };
		}
		if (
			command === "git" &&
			args[2] === "status" &&
			args[3] === "--porcelain"
		) {
			return { stdout: "", stderr: "" };
		}
		if (
			command === "git" &&
			args[2] === "rev-parse" &&
			args[3] === "--git-common-dir"
		) {
			return { stdout: `${path.join(state.repoRoot, ".git")}\n`, stderr: "" };
		}
		if (command === "git" && args[2] === "worktree" && args[3] === "remove") {
			const worktreePath = args[args.length - 1];
			await fs.rm(worktreePath, { recursive: true, force: true });
			return { stdout: "", stderr: "" };
		}
		throw new Error(`Unhandled command: ${command} ${args.join(" ")}`);
	};
};

const setup = async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-lane-test-"));
	const repoRoot = path.join(root, "repo");
	const worktreeRoot = path.join(root, "lane-worktrees");
	await fs.mkdir(repoRoot, { recursive: true });
	const registry = new LaneRegistryStore(path.join(root, "lane-registry.json"));
	const state: FakeState = {
		repoRoot,
		aliveSessions: new Set<string>(),
		launchCommands: [],
	};
	let seq = 0;
	const manager = new LaneManager({
		runner: createFakeRunner(state),
		registry,
		randomId: () => {
			seq += 1;
			return `${String(seq).padStart(8, "0")}-2222-3333-4444-555555555555`;
		},
		launchCommand: "codelia",
		defaultWorktreeRoot: worktreeRoot,
	});
	return {
		repoRoot,
		registry,
		state,
		manager,
		async cleanup() {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
};

describe("LaneManager", () => {
	test("create starts a running lane", async () => {
		const env = await setup();
		try {
			const lane = await env.manager.create(
				{
					task_id: "Bug Fix",
				},
				{ workingDir: env.repoRoot },
			);
			expect(lane.state).toBe("running");
			expect(lane.mux_backend).toBe("tmux");
			expect(lane.worktree_path).toContain("lane-worktrees/bug-fix-00000001");
			expect(env.state.aliveSessions.has(lane.mux_target)).toBe(true);
		} finally {
			await env.cleanup();
		}
	});

	test("create passes seed_context via initial-message launch option", async () => {
		const env = await setup();
		try {
			await env.manager.create(
				{
					task_id: "Seed Context",
					seed_context: "Investigate foo and bar's state",
				},
				{ workingDir: env.repoRoot },
			);

			const launch = env.state.launchCommands.find((value) =>
				value.includes("codelia"),
			);
			expect(launch).toBeDefined();
			expect(launch).toContain("--initial-message");
			expect(launch).toContain("Investigate foo and bar");
			expect(launch).toContain("bar'\\''s");
		} finally {
			await env.cleanup();
		}
	});

	test("close rejects running lane without force", async () => {
		const env = await setup();
		try {
			const lane = await env.manager.create(
				{
					task_id: "Close Guard",
				},
				{ workingDir: env.repoRoot },
			);
			await expect(
				env.manager.close({ lane_id: lane.lane_id }),
			).rejects.toMatchObject({
				code: "lane_running",
			});

			const closed = await env.manager.close({
				lane_id: lane.lane_id,
				force: true,
				remove_worktree: true,
			});
			expect(closed.state).toBe("closed");
			expect(env.state.aliveSessions.has(lane.mux_target)).toBe(false);
		} finally {
			await env.cleanup();
		}
	});

	test("gc closes stale finished lanes and keeps running lanes", async () => {
		const env = await setup();
		try {
			const running = await env.manager.create(
				{
					task_id: "Still Running",
				},
				{ workingDir: env.repoRoot },
			);
			const finished = await env.manager.create(
				{
					task_id: "Done Work",
					worktree_path: ".codelia/worktrees/done-work",
				},
				{ workingDir: env.repoRoot },
			);
			env.state.aliveSessions.delete(finished.mux_target);
			await env.manager.status(finished.lane_id);
			await env.registry.patch(finished.lane_id, {
				last_activity_at: new Date(
					Date.now() - 2 * 60 * 60 * 1000,
				).toISOString(),
			});

			const result = await env.manager.gc({
				idle_ttl_minutes: 30,
				remove_worktree: false,
			});
			expect(result.closed).toBe(1);
			expect(result.errors).toEqual([]);

			const afterRunning = await env.manager.status(running.lane_id);
			expect(afterRunning.lane.state).toBe("running");
			const afterFinished = (await env.registry.get(
				finished.lane_id,
			)) as LaneRecord;
			expect(afterFinished.state).toBe("closed");
		} finally {
			await env.cleanup();
		}
	});
});
