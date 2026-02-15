import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { debugLog } from "../logger";
import { type CommandRunner, runCommand } from "./command";
import { LaneRegistryStore } from "./registry";
import type {
	LaneBackend,
	LaneCloseInput,
	LaneCreateInput,
	LaneGcInput,
	LaneRecord,
} from "./types";

const nowIso = (): string => new Date().toISOString();
const INITIAL_MESSAGE_FLAG = "--initial-message";

const toSlug = (value: string): string => {
	const normalized = value
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "");
	return normalized || "task";
};

const parseDate = (value: string): number => {
	const ts = Date.parse(value);
	if (Number.isNaN(ts)) return 0;
	return ts;
};

const isNotFoundError = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("command not found") ||
		message.includes("ENOENT") ||
		message.includes("not found")
	);
};

const isExitFailure = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("failed (exit");
};

export class LaneManagerError extends Error {
	readonly code:
		| "backend_not_found"
		| "lane_not_found"
		| "lane_running"
		| "worktree_dirty"
		| "backend_command_failed";

	constructor(
		code:
			| "backend_not_found"
			| "lane_not_found"
			| "lane_running"
			| "worktree_dirty"
			| "backend_command_failed",
		message: string,
	) {
		super(message);
		this.code = code;
		this.name = "LaneManagerError";
	}
}

type LaneManagerOptions = {
	runner?: CommandRunner;
	registry?: LaneRegistryStore;
	now?: () => string;
	randomId?: () => string;
	launchCommand?: string;
	defaultWorktreeRoot?: string;
};

export class LaneManager {
	private readonly runner: CommandRunner;
	private readonly registry: LaneRegistryStore;
	private readonly now: () => string;
	private readonly randomId: () => string;
	private readonly launchCommand: string;
	private readonly defaultWorktreeRoot: string;

	constructor(options: LaneManagerOptions = {}) {
		this.runner = options.runner ?? runCommand;
		this.registry = options.registry ?? new LaneRegistryStore();
		this.now = options.now ?? nowIso;
		this.randomId = options.randomId ?? (() => crypto.randomUUID());
		this.launchCommand =
			options.launchCommand ??
			process.env.CODELIA_LANE_LAUNCH_COMMAND?.trim() ??
			"codelia";
		this.defaultWorktreeRoot =
			options.defaultWorktreeRoot ??
			path.join(os.homedir(), ".codelia", "worktrees");
	}

	private async cmd(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number },
	): Promise<{ stdout: string; stderr: string }> {
		debugLog(`lane.cmd ${command} ${args.join(" ")}`);
		return this.runner(command, args, options);
	}

	private async resolveRepoRoot(workingDir: string): Promise<string> {
		const { stdout } = await this.cmd(
			"git",
			["-C", workingDir, "rev-parse", "--show-toplevel"],
			{ cwd: workingDir },
		);
		const root = stdout.trim();
		if (!root) {
			throw new LaneManagerError(
				"backend_command_failed",
				"Could not resolve git repository root.",
			);
		}
		return root;
	}

	private async preflightBackend(backend: LaneBackend): Promise<void> {
		if (backend === "tmux") {
			try {
				await this.cmd("tmux", ["-V"]);
				return;
			} catch (error) {
				if (isNotFoundError(error)) {
					throw new LaneManagerError(
						"backend_not_found",
						"tmux not found in PATH.",
					);
				}
				throw new LaneManagerError(
					"backend_command_failed",
					`tmux preflight failed: ${String(error)}`,
				);
			}
		}
		try {
			await this.cmd("zellij", ["--version"]);
		} catch (error) {
			if (isNotFoundError(error)) {
				throw new LaneManagerError(
					"backend_not_found",
					"zellij not found in PATH.",
				);
			}
			throw new LaneManagerError(
				"backend_command_failed",
				`zellij preflight failed: ${String(error)}`,
			);
		}
		throw new LaneManagerError(
			"backend_command_failed",
			"zellij backend is not supported yet in lane MVP. Use tmux.",
		);
	}

	private async startTmuxLane(
		target: string,
		worktreePath: string,
		seedContext?: string,
	): Promise<void> {
		const launchCommand = this.buildLaunchCommand(seedContext);
		await this.cmd("tmux", [
			"new-session",
			"-d",
			"-s",
			target,
			"-c",
			worktreePath,
		]);
		const paneTarget = `${target}:0.0`;
		await this.cmd("tmux", [
			"send-keys",
			"-t",
			paneTarget,
			"-l",
			launchCommand,
		]);
		await this.cmd("tmux", ["send-keys", "-t", paneTarget, "Enter"]);
	}

	private shellQuote(value: string): string {
		if (!value) return "''";
		return `'${value.replaceAll("'", "'\\''")}'`;
	}

	private buildLaunchCommand(seedContext?: string): string {
		const seed = seedContext?.trim();
		if (!seed) {
			return this.launchCommand;
		}
		return `${this.launchCommand} ${INITIAL_MESSAGE_FLAG} ${this.shellQuote(seed)}`;
	}

	private async isTmuxAlive(target: string): Promise<boolean> {
		try {
			await this.cmd("tmux", ["has-session", "-t", target], {
				timeoutMs: 5_000,
			});
			return true;
		} catch (error) {
			if (isExitFailure(error)) return false;
			throw new LaneManagerError(
				"backend_command_failed",
				`tmux status failed: ${String(error)}`,
			);
		}
	}

	private async stopTmuxLane(target: string): Promise<void> {
		try {
			await this.cmd("tmux", ["kill-session", "-t", target], {
				timeoutMs: 10_000,
			});
		} catch (error) {
			if (isExitFailure(error)) return;
			throw new LaneManagerError(
				"backend_command_failed",
				`tmux close failed: ${String(error)}`,
			);
		}
	}

	private async resolveWorktreeMainRoot(worktreePath: string): Promise<string> {
		const { stdout } = await this.cmd("git", [
			"-C",
			worktreePath,
			"rev-parse",
			"--git-common-dir",
		]);
		const commonDir = path.resolve(worktreePath, stdout.trim());
		if (path.basename(commonDir) === ".git") {
			return path.dirname(commonDir);
		}
		return await this.resolveRepoRoot(worktreePath);
	}

	private async isWorktreeDirty(worktreePath: string): Promise<boolean> {
		try {
			await fs.access(worktreePath);
		} catch {
			return false;
		}
		const { stdout } = await this.cmd("git", [
			"-C",
			worktreePath,
			"status",
			"--porcelain",
		]);
		return stdout.trim().length > 0;
	}

	private async removeWorktree(
		worktreePath: string,
		force: boolean,
	): Promise<void> {
		try {
			await fs.access(worktreePath);
		} catch {
			return;
		}
		const repoRoot = await this.resolveWorktreeMainRoot(worktreePath);
		const args = ["-C", repoRoot, "worktree", "remove"];
		if (force) args.push("--force");
		args.push(worktreePath);
		await this.cmd("git", args);
	}

	async create(
		input: LaneCreateInput,
		options: { workingDir: string },
	): Promise<LaneRecord> {
		const taskId = input.task_id.trim();
		if (!taskId) {
			throw new LaneManagerError(
				"backend_command_failed",
				"task_id is required.",
			);
		}
		const backend: LaneBackend = input.mux_backend ?? "tmux";
		await this.preflightBackend(backend);

		const repoRoot = await this.resolveRepoRoot(options.workingDir);
		const laneId = this.randomId();
		const slug = toSlug(taskId);
		const shortId = laneId.slice(0, 8);
		const branchName = `lane/${slug}-${shortId}`;
		const worktreePath = input.worktree_path
			? path.resolve(options.workingDir, input.worktree_path)
			: path.join(this.defaultWorktreeRoot, `${slug}-${shortId}`);
		const muxTarget = `codelia-lane-${shortId}`;
		const createdAt = this.now();
		const record: LaneRecord = {
			lane_id: laneId,
			task_id: taskId,
			state: "creating",
			mux_backend: backend,
			mux_target: muxTarget,
			worktree_path: worktreePath,
			branch_name: branchName,
			session_id: crypto.randomUUID(),
			created_at: createdAt,
			updated_at: createdAt,
			last_activity_at: createdAt,
		};

		await this.registry.upsert(record);
		try {
			await fs.mkdir(path.dirname(worktreePath), { recursive: true });
			await this.cmd("git", [
				"-C",
				repoRoot,
				"worktree",
				"add",
				"-b",
				branchName,
				worktreePath,
				input.base_ref?.trim() || "HEAD",
			]);
			if (backend === "tmux") {
				await this.startTmuxLane(muxTarget, worktreePath, input.seed_context);
			}
			const running = await this.registry.patch(laneId, {
				state: "running",
				last_activity_at: this.now(),
				last_error: undefined,
			});
			if (!running) {
				throw new Error("lane record disappeared during create");
			}
			return running;
		} catch (error) {
			await this.registry.patch(laneId, {
				state: "error",
				last_error: String(error),
				last_activity_at: this.now(),
			});
			throw new LaneManagerError(
				"backend_command_failed",
				`lane.create failed (${laneId}): ${String(error)}`,
			);
		}
	}

	async list(input?: { include_closed?: boolean }): Promise<LaneRecord[]> {
		const all = await this.registry.list();
		if (input?.include_closed) return all;
		return all.filter((lane) => lane.state !== "closed");
	}

	async status(
		laneId: string,
	): Promise<{ lane: LaneRecord; backend_alive: boolean }> {
		const lane = await this.registry.get(laneId);
		if (!lane) {
			throw new LaneManagerError("lane_not_found", `Lane not found: ${laneId}`);
		}
		let alive = false;
		if (lane.state !== "closed") {
			if (lane.mux_backend === "tmux") {
				alive = await this.isTmuxAlive(lane.mux_target);
			}
			if (lane.state === "running" && !alive) {
				const patched = await this.registry.patch(lane.lane_id, {
					state: "finished",
					last_activity_at: this.now(),
				});
				if (patched) {
					return { lane: patched, backend_alive: false };
				}
			}
		}
		return { lane, backend_alive: alive };
	}

	async close(input: LaneCloseInput): Promise<LaneRecord> {
		const lane = await this.registry.get(input.lane_id);
		if (!lane) {
			throw new LaneManagerError(
				"lane_not_found",
				`Lane not found: ${input.lane_id}`,
			);
		}
		if (lane.state === "closed") {
			return lane;
		}
		const force = input.force === true;
		const removeWorktree = input.remove_worktree !== false;
		const status = await this.status(lane.lane_id);
		const refreshed = status.lane;
		if (status.backend_alive && !force) {
			throw new LaneManagerError(
				"lane_running",
				`Lane is still running: ${lane.lane_id}`,
			);
		}
		if (status.backend_alive && refreshed.mux_backend === "tmux") {
			await this.stopTmuxLane(refreshed.mux_target);
		}
		if (removeWorktree) {
			const dirty = await this.isWorktreeDirty(refreshed.worktree_path);
			if (dirty && !force) {
				throw new LaneManagerError(
					"worktree_dirty",
					`Worktree has uncommitted changes: ${refreshed.worktree_path}`,
				);
			}
			await this.removeWorktree(refreshed.worktree_path, force);
		}
		const closed = await this.registry.patch(refreshed.lane_id, {
			state: "closed",
			last_activity_at: this.now(),
		});
		if (!closed) {
			throw new LaneManagerError(
				"backend_command_failed",
				"Failed to persist lane close state.",
			);
		}
		return closed;
	}

	async gc(input: LaneGcInput): Promise<{
		checked: number;
		closed: number;
		skipped: number;
		errors: string[];
	}> {
		const ttlMs = Math.max(1, input.idle_ttl_minutes) * 60_000;
		const now = Date.now();
		const lanes = await this.registry.list();
		let closed = 0;
		let skipped = 0;
		const errors: string[] = [];

		for (const lane of lanes) {
			try {
				const status = await this.status(lane.lane_id);
				const current = status.lane;
				if (current.state === "running" || current.state === "closed") {
					skipped += 1;
					continue;
				}
				if (current.state !== "finished" && current.state !== "error") {
					skipped += 1;
					continue;
				}
				const idleSince =
					parseDate(current.last_activity_at) || parseDate(current.updated_at);
				if (idleSince <= 0 || now - idleSince < ttlMs) {
					skipped += 1;
					continue;
				}
				await this.close({
					lane_id: current.lane_id,
					remove_worktree: input.remove_worktree,
					force: input.force,
				});
				closed += 1;
			} catch (error) {
				errors.push(`${lane.lane_id}: ${String(error)}`);
			}
		}
		return {
			checked: lanes.length,
			closed,
			skipped,
			errors,
		};
	}
}
