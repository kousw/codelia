import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type TaskRecord, TaskRegistryStore } from "../src";

const makeTask = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
	version: 1,
	task_id: overrides.task_id ?? "task-1",
	kind: overrides.kind ?? "shell",
	workspace_mode: overrides.workspace_mode ?? "live_workspace",
	state: overrides.state ?? "queued",
	owner_runtime_id: overrides.owner_runtime_id ?? "runtime-1",
	owner_pid: overrides.owner_pid ?? 101,
	created_at: overrides.created_at ?? "2026-03-08T10:00:00.000Z",
	updated_at: overrides.updated_at ?? "2026-03-08T10:00:00.000Z",
	...overrides,
});

describe("TaskRegistryStore", () => {
	test("upsert/get/list/patch persist per-task records", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-task-registry-"),
		);
		try {
			const store = new TaskRegistryStore(path.join(root, "tasks"));
			const first = makeTask({
				task_id: "task-a",
				updated_at: "2026-03-08T10:00:00.000Z",
			});
			const second = makeTask({
				task_id: "task-b",
				state: "running",
				updated_at: "2026-03-08T11:00:00.000Z",
				key: "test-abcd1234",
				label: "test",
				title: "npm test",
				working_directory: "/tmp/project",
				executor_pid: 222,
			});

			await store.upsert(first);
			await store.upsert(second);

			expect(await store.get("task-b")).toEqual(second);
			expect((await store.list()).map((task) => task.task_id)).toEqual([
				"task-b",
				"task-a",
			]);

			const patched = await store.patch("task-b", {
				state: "completed",
				updated_at: "2026-03-08T12:00:00.000Z",
				ended_at: "2026-03-08T12:00:00.000Z",
				result: { summary: "done" },
			});
			expect(patched).toEqual({
				...second,
				state: "completed",
				updated_at: "2026-03-08T12:00:00.000Z",
				ended_at: "2026-03-08T12:00:00.000Z",
				result: { summary: "done" },
			});
			expect((await store.get("task-b"))?.created_at).toBe(second.created_at);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("list/get backfill missing shell keys with prefixed public ids", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-task-registry-"),
		);
		try {
			const store = new TaskRegistryStore(path.join(root, "tasks"));
			await store.upsert(
				makeTask({
					task_id: "789644f4-59f6-4672-b2fa-bb02651b9c8a",
					label: "build",
				}),
			);
			await store.upsert(
				makeTask({ task_id: "93285239-e152-4474-9527-3d4900ae7574" }),
			);

			const listed = await store.list();
			const buildTask = listed.find((task) => task.label === "build");
			const shellTask = listed.find(
				(task) => task.task_id === "93285239-e152-4474-9527-3d4900ae7574",
			);
			expect(buildTask?.key).toBe("build-789644f4");
			expect(shellTask?.key).toBe("shell-93285239");
			expect(
				(await store.get("789644f4-59f6-4672-b2fa-bb02651b9c8a"))?.key,
			).toBe("build-789644f4");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("list ignores malformed task files", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-task-registry-"),
		);
		try {
			const tasksDir = path.join(root, "tasks");
			const store = new TaskRegistryStore(tasksDir);
			await store.upsert(makeTask({ task_id: "good-task" }));
			await fs.mkdir(tasksDir, { recursive: true });
			await fs.writeFile(
				path.join(tasksDir, "broken.json"),
				'{\n  "version": 1,\n  "task_id": 123\n}\n',
				"utf8",
			);

			const listed = await store.list();
			expect(listed).toHaveLength(1);
			expect(listed[0]?.task_id).toBe("good-task");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
