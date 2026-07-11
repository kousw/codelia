import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable, Writable } from "node:stream";
import type { ToolOutputCacheStore } from "@codelia/core";
import { startShellTask } from "../src/tasks/shell-executor";
import { MAX_EXECUTION_TIMEOUT_SECONDS } from "../src/tools/bash-utils";

type FakeShellChild = EventEmitter & {
	pid: number;
	stdout: Readable;
	stderr: Readable;
	stdin: Writable;
	kill: (signal?: NodeJS.Signals | number) => boolean;
};

const createFakeChild = (options?: {
	onKill?: (
		signal: NodeJS.Signals | number | undefined,
		child: FakeShellChild,
	) => void;
}): FakeShellChild => {
	const child = new EventEmitter() as FakeShellChild;
	child.pid = 4242;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdin = new PassThrough();
	child.kill = (signal) => {
		options?.onKill?.(signal, child);
		return true;
	};
	return child;
};

const noopCacheStore: ToolOutputCacheStore = {
	save: async () => ({
		id: "cache-id",
		file_path: "/tmp/cache-id",
		byte_length: 1,
		line_count: 1,
	}),
};

describe("startShellTask", () => {
	test("writes UTF-8 input through an opt-in pipe and closes it once", async () => {
		const child = createFakeChild();
		let received = "";
		child.stdin.on("data", (chunk) => {
			received += chunk.toString("utf8");
		});
		const task = startShellTask({
			taskId: "task-stdin-pipe",
			command: "read input",
			cwd: process.cwd(),
			stdinMode: "pipe",
			outputCache: noopCacheStore,
			spawnProcess: () => child as never,
		});

		const first = await task.writeInput?.({ text: "héllo", close: false });
		const second = await task.writeInput?.({ text: "\n", close: true });

		expect(first).toEqual({ bytes_written: 6, stdin_closed: false });
		expect(second).toEqual({ bytes_written: 1, stdin_closed: true });
		expect(received).toBe("héllo\n");
		await expect(
			task.writeInput?.({ text: "late", close: false }),
		).rejects.toThrow("stdin is already closed");
		child.emit("close", 0, null);
		await task.wait;
	});

	test("does not expose writes for the default closed stdin mode", () => {
		const child = createFakeChild();
		const task = startShellTask({
			taskId: "task-stdin-closed",
			command: "printf test",
			cwd: process.cwd(),
			outputCache: noopCacheStore,
			spawnProcess: () => child as never,
		});
		expect(task.writeInput).toBeUndefined();
		child.emit("close", 0, null);
	});

	test("serializes writes and times out stalled writable callbacks", async () => {
		const child = createFakeChild();
		const callbacks: Array<() => void> = [];
		child.stdin = new Writable({
			write(_chunk, _encoding, callback) {
				callbacks.push(callback);
			},
		});
		const task = startShellTask({
			taskId: "task-stdin-serialized",
			command: "read input",
			cwd: process.cwd(),
			stdinMode: "pipe",
			stdinWriteTimeoutMs: 100,
			outputCache: noopCacheStore,
			spawnProcess: () => child as never,
		});

		const first = task.writeInput?.({ text: "first", close: false });
		const second = task.writeInput?.({ text: "second", close: false });
		await Bun.sleep(0);
		expect(callbacks).toHaveLength(1);
		callbacks.shift()?.();
		await first;
		await Bun.sleep(0);
		expect(callbacks).toHaveLength(1);
		callbacks.shift()?.();
		await second;

		const stalled = task.writeInput?.({ text: "stalled", close: false });
		await expect(stalled).rejects.toThrow(
			"stdin write timed out waiting for backpressure",
		);
		child.emit("close", 0, null);
		await task.wait;
	});

	test("reports rounded non-negative duration from the injected monotonic clock", async () => {
		const child = createFakeChild();
		const clockValues = [100, 106.6];
		const task = startShellTask({
			taskId: "task-monotonic-duration",
			command: "printf test",
			cwd: process.cwd(),
			outputCache: noopCacheStore,
			monotonicNowMs: () => {
				const value = clockValues.shift();
				if (value === undefined) throw new Error("unexpected clock read");
				return value;
			},
			spawnProcess: () => child as never,
		});

		child.emit("close", 0, null);

		const result = await task.wait;
		expect(result.result?.duration_ms).toBe(7);
		expect(clockValues).toEqual([]);
	});

	test("falls back to inline result when cache save fails", async () => {
		const child = createFakeChild();
		const clockValues = [500, 490];
		const task = startShellTask({
			taskId: "task-cache-fallback",
			command: "printf test",
			cwd: process.cwd(),
			outputCache: {
				save: async () => {
					throw new Error("cache unavailable");
				},
			},
			monotonicNowMs: () => {
				const value = clockValues.shift();
				if (value === undefined) throw new Error("unexpected clock read");
				return value;
			},
			spawnProcess: () => child as never,
		});

		(child.stdout as PassThrough).write("x".repeat(70_000));
		child.emit("close", 0, null);

		const result = await task.wait;
		expect(result.state).toBe("completed");
		expect(result.result?.truncated?.stdout).toBe(true);
		expect(result.result?.stdout).toContain("...[truncated by size]...");
		expect(result.result?.stdout_cache_id).toBeUndefined();
		expect(result.result?.duration_ms).toBe(0);
		expect(clockValues).toEqual([]);
	});

	test("persists cache ids for whitespace-only truncated output", async () => {
		const child = createFakeChild();
		const rawStdout = "\n".repeat(500);
		const savedContent: string[] = [];
		const task = startShellTask({
			taskId: "task-whitespace-cache",
			command: "printf whitespace",
			cwd: process.cwd(),
			outputCache: {
				save: async (input) => {
					savedContent.push(input.content);
					return {
						id: `cache-${savedContent.length}`,
						file_path: `/tmp/cache-${savedContent.length}`,
						byte_length: Buffer.byteLength(input.content, "utf8"),
						line_count: input.content.split(/\r?\n/).length,
					};
				},
			},
			spawnProcess: () => child as never,
		});

		(child.stdout as PassThrough).end(rawStdout);
		child.emit("close", 0, null);

		const result = await task.wait;
		expect(result.state).toBe("completed");
		expect(result.result?.truncated?.stdout).toBe(true);
		expect(result.result?.stdout_cache_id).toBe("cache-1");
		expect(savedContent).toEqual([rawStdout]);
	});

	test("omitted timeout does not arm an execution timer", async () => {
		const signals: Array<string | number | undefined> = [];
		const child = createFakeChild({
			onKill: (signal, current) => {
				signals.push(signal);
				if (signal === "SIGTERM") {
					current.emit("close", null, "SIGTERM");
				}
			},
		});
		const task = startShellTask({
			taskId: "task-no-timeout",
			command: "sleep forever",
			cwd: process.cwd(),
			outputCache: noopCacheStore,
			spawnProcess: () => child as never,
		});

		await Bun.sleep(20);
		expect(signals).toEqual([]);
		expect(task.cancel).toBeDefined();
		await task.cancel?.();
		const result = await task.wait;
		expect(result.state).toBe("cancelled");
		expect(signals).toEqual(["SIGTERM"]);
	});

	test("rejects timeout values beyond Node timer range", () => {
		const child = createFakeChild();
		expect(() =>
			startShellTask({
				taskId: "task-timeout-overflow",
				command: "sleep forever",
				cwd: process.cwd(),
				timeoutSeconds: MAX_EXECUTION_TIMEOUT_SECONDS + 1,
				outputCache: noopCacheStore,
				spawnProcess: () => child as never,
			}),
		).toThrow("timer range");
	});

	test("timeout keeps force-kill armed until the hung child closes", async () => {
		const signals: Array<string | number | undefined> = [];
		const child = createFakeChild({
			onKill: (signal, current) => {
				signals.push(signal);
				if (signal === "SIGKILL") {
					current.emit("close", null, "SIGKILL");
				}
			},
		});
		const task = startShellTask({
			taskId: "task-timeout-force-kill",
			command: "sleep forever",
			cwd: process.cwd(),
			timeoutSeconds: 0.01,
			forceKillDelayMs: 1,
			outputCache: noopCacheStore,
			spawnProcess: () => child as never,
		});

		const result = await task.wait;
		expect(result.state).toBe("failed");
		expect(result.result?.signal).toBe("SIGTERM");
		await Bun.sleep(10);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	test("output overflow keeps force-kill armed until the hung child closes", async () => {
		const signals: Array<string | number | undefined> = [];
		const child = createFakeChild({
			onKill: (signal, current) => {
				signals.push(signal);
				if (signal === "SIGKILL") {
					current.emit("close", null, "SIGKILL");
				}
			},
		});
		const task = startShellTask({
			taskId: "task-overflow-force-kill",
			command: "cat huge",
			cwd: process.cwd(),
			maxOutputBytes: 4,
			forceKillDelayMs: 1,
			outputCache: noopCacheStore,
			spawnProcess: () => child as never,
		});

		(child.stdout as PassThrough).write("abcdef");
		const result = await task.wait;
		expect(result.state).toBe("failed");
		expect(result.result?.signal).toBe("SIGTERM");
		await Bun.sleep(10);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
