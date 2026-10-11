import assert from "node:assert/strict";
import { spawn } from "node:child_process";
/** Opt-in, deterministic end-to-end checks against the real runtime and a loopback model. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
	AgentEventNotify,
	InitializeResult,
	RunStartResult,
	SessionListResult,
	TaskInfo,
	TaskListResult,
} from "@codelia/protocol";

const repo = resolve(import.meta.dir, "../../..");
const fixture = resolve(repo, `tmp/desktop-smoke-headless-${Date.now()}`);
const provider = spawn(
	process.execPath,
	[resolve(import.meta.dir, "local-provider.ts"), fixture],
	{ cwd: repo, stdio: "ignore" },
);
let runtime: ReturnType<typeof spawn> | undefined;
let scenarioError: unknown;
let cleanupError: Error | undefined;
console.log(`Fixture: ${fixture}; provider=${provider.pid}`);
try {
	for (let n = 0; n < 100 && !existsSync(`${fixture}/provider.json`); n++)
		await Bun.sleep(50);
	const { url } = JSON.parse(
		readFileSync(`${fixture}/provider.json`, "utf8"),
	) as { url: string };
	runtime = spawn(
		process.execPath,
		[resolve(repo, "packages/runtime/src/index.ts")],
		{
			cwd: `${fixture}/workspace`,
			stdio: ["pipe", "pipe", "ignore"],
			env: {
				...process.env,
				OPENAI_API_KEY: "fixture-not-a-secret",
				OPENAI_BASE_URL: url,
				CODELIA_LAYOUT: "xdg",
				XDG_CONFIG_HOME: `${fixture}/config`,
				XDG_CACHE_HOME: `${fixture}/cache`,
				XDG_STATE_HOME: `${fixture}/state`,
			},
		},
	);
	console.log(`Runtime PID: ${runtime.pid}`);
	let counter = 0;
	let allow = false;
	let holdMultiApproval = false;
	let heldApproval = false;
	let confirmCount = 0;
	let heldApprovalId: string | undefined;
	const cancelledRequests = new Set<string>();
	let holdChildApproval = false;
	let childApproval: { requestId: string; taskId: string } | undefined;
	const pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	const statuses = new Map<string, string>();
	const events: AgentEventNotify[] = [];
	const appCalls: Array<{ arguments: Record<string, unknown> }> = [];
	const write = (message: unknown) =>
		runtime?.stdin?.write(`${JSON.stringify(message)}\n`);
	const rpc = <T = unknown>(method: string, params: unknown = {}) =>
		new Promise<T>((resolve, reject) => {
			const id = `smoke-${++counter}`;
			pending.set(id, { resolve: (value) => resolve(value as T), reject });
			write({ jsonrpc: "2.0", id, method, params });
		});
	assert(runtime.stdout);
	createInterface({ input: runtime.stdout }).on("line", (line) => {
		const message = JSON.parse(line) as {
			id: string;
			method?: string;
			result: unknown;
			error?: { message: string };
			params: {
				run_id: string;
				status: string;
				arguments: Record<string, unknown>;
				message?: string;
				event: AgentEventNotify["event"];
				seq: number;
				request_id?: string;
				task_id?: string;
			};
		};
		if (!message.method) {
			const waiter = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) waiter?.reject(new Error(message.error.message));
			else waiter?.resolve(message.result);
			return;
		}
		if (message.method === "run.status")
			statuses.set(message.params.run_id, message.params.status);
		if (message.method === "agent.event") events.push(message.params);
		if (message.method === "ui.request.cancel" && message.params.request_id)
			cancelledRequests.add(message.params.request_id);
		if (message.method === "ui.pick.request")
			write({ jsonrpc: "2.0", id: message.id, result: { ids: ["minimal"] } });
		if (message.method === "ui.confirm.request") {
			confirmCount++;
			if (holdChildApproval && message.params.task_id) {
				childApproval = {
					requestId: message.id,
					taskId: message.params.task_id,
				};
			} else if (
				holdMultiApproval &&
				message.params.message?.includes("multi-approved.txt")
			) {
				heldApproval = true;
				heldApprovalId = message.id;
			} else
				write({
					jsonrpc: "2.0",
					id: message.id,
					result: { ok: allow, remember: false },
				});
		}
		if (message.method === "client.tool.call") {
			appCalls.push(message.params);
			write({
				jsonrpc: "2.0",
				id: message.id,
				result: { ok: true, result: { thread_id: "fixture-draft" } },
			});
		}
	});
	const until = async (predicate: () => boolean, label: string) => {
		for (let n = 0; n < 400; n++) {
			if (predicate()) return;
			await Bun.sleep(25);
		}
		throw new Error(`Timeout: ${label}`);
	};
	const initial = await rpc<InitializeResult>("initialize", {
		protocol_version: "0",
		client: { name: "codelia-desktop-smoke", version: "0.1.0" },
		ui_capabilities: {
			supports_confirm: true,
			supports_prompt: true,
			supports_pick: true,
			supports_permission_preflight_events: true,
			supports_ui_request_cancel: true,
			supports_text_stream: true,
		},
	});
	assert.equal(initial.protocol_version, "0");
	assert.equal(initial.server_capabilities?.supports_ui_request_cancel, true);
	let session: string | undefined;
	const start = async (text: string, tools?: unknown[]) => {
		const result = await rpc<RunStartResult>("run.start", {
			...(session ? { session_id: session } : {}),
			input: { type: "text", text },
			ui_context: {
				cwd: `${fixture}/workspace`,
				workspace_root: `${fixture}/workspace`,
			},
			...(tools ? { tools } : {}),
		});
		session = result.session_id;
		return result.run_id as string;
	};
	const done = async (run: string) =>
		until(
			() =>
				["completed", "error", "cancelled"].includes(statuses.get(run) ?? ""),
			`terminal ${run}`,
		);
	let run = await start("native-smoke:approval denied");
	await done(run);
	assert(!existsSync(`${fixture}/workspace/approved.txt`));
	allow = true;
	run = await start("native-smoke:approval allowed");
	await done(run);
	assert.equal(
		readFileSync(`${fixture}/workspace/approved.txt`, "utf8"),
		"Native approval succeeded.\n",
	);
	const confirmsBeforeSecondWrite = confirmCount;
	run = await start("native-smoke:approval allowed again");
	await done(run);
	assert.equal(
		confirmCount,
		confirmsBeforeSecondWrite + 1,
		"Allow once must still require approval for the next write",
	);
	assert.equal(
		readFileSync(`${fixture}/workspace/approved-again.txt`, "utf8"),
		"Native approval succeeded.\n",
	);
	assert.equal(
		JSON.parse(readFileSync(`${fixture}/config/codelia/config.json`, "utf8"))
			.permissions,
		undefined,
		"Once decisions must not add a global permission rule",
	);
	assert(
		!existsSync(`${fixture}/workspace/.codelia/config.json`),
		"Once decisions must not create project permission configuration",
	);
	run = await start("native-smoke:app", [
		{
			name: "codelia_app",
			description: "Create a fixture draft",
			parameters: {
				type: "object",
				properties: { action: { type: "string" }, title: { type: "string" } },
				required: ["action"],
			},
			approval: "never",
		},
	]);
	await done(run);
	assert.equal(appCalls.at(-1)?.arguments.action, "create_thread");
	run = await start("native-smoke:delegate");
	await done(run);
	const tasks = await rpc<TaskListResult>("task.list", { limit: 100 });
	assert(tasks.tasks.some((task) => task.kind === "subagent"));
	const child = tasks.tasks.find((task) => task.kind === "subagent");
	assert(child);
	let childStatus: TaskInfo | undefined;
	for (let n = 0; n < 100; n++) {
		childStatus = await rpc<TaskInfo>("task.status", {
			task_id: child.task_id,
		});
		if (childStatus.state !== "running" && childStatus.state !== "queued")
			break;
		await Bun.sleep(50);
	}
	assert(childStatus);
	assert.equal(childStatus.state, "completed");
	assert(childStatus.summary?.includes("Native Codelia runtime"));
	holdMultiApproval = true;
	run = await start("native-smoke:multi");
	await until(() => heldApproval, "parent approval with two children");
	let multiTasks: TaskInfo[] = [];
	for (let n = 0; n < 100; n++) {
		multiTasks = (
			await rpc<TaskListResult>("task.list", { limit: 100 })
		).tasks.filter((task) => task.name === "alpha" || task.name === "beta");
		if (
			multiTasks.length === 2 &&
			multiTasks.every((task) => task.state === "running")
		)
			break;
		await Bun.sleep(25);
	}
	assert.equal(multiTasks.length, 2);
	assert(
		multiTasks.every((task) => task.state === "running"),
		JSON.stringify(
			multiTasks.map((task) => ({
				name: task.name,
				state: task.state,
				failure: task.failure_message,
			})),
		),
	);
	await rpc("run.cancel", { run_id: run });
	await done(run);
	assert.equal(statuses.get(run), "cancelled");
	assert(heldApprovalId && cancelledRequests.has(heldApprovalId));
	for (const task of multiTasks) {
		assert.equal(
			(await rpc<TaskInfo>("task.status", { task_id: task.task_id })).state,
			"running",
		);
		const cancelled = await rpc<TaskInfo>("task.cancel", {
			task_id: task.task_id,
		});
		assert.equal(cancelled.state, "cancelled");
	}
	assert(!existsSync(`${fixture}/workspace/multi-approved.txt`));
	holdMultiApproval = false;
	run = await start("native-smoke:slow");
	await until(() => statuses.get(run) === "running", "slow running");
	await rpc("run.cancel", { run_id: run });
	await done(run);
	assert.equal(statuses.get(run), "cancelled");
	run = await start("native-smoke:error");
	await done(run);
	assert.equal(statuses.get(run), "error");
	run = await start("recover after error");
	await done(run);
	assert.equal(statuses.get(run), "completed");
	run = await start("native-smoke:stream");
	await until(
		() => existsSync(`${fixture}/stream-first-delta`),
		"provider emitted genuine text delta",
	);
	await rpc("model.list");
	assert(
		!events.some(
			(event) =>
				event.run_id === run && ["text", "final"].includes(event.event.type),
		),
		"canonical text must remain completion-only",
	);
	await until(
		() =>
			events.some(
				(event) =>
					event.run_id === run &&
					event.event.type === "text.stream" &&
					event.event.phase === "delta" &&
					event.event.content === "Native partial",
			),
		"live text before provider completion",
	);
	assert.equal(statuses.get(run), "running");
	writeFileSync(`${fixture}/stream-release`, "release terminal response");
	await done(run);
	assert(
		events.some(
			(event) =>
				event.run_id === run &&
				event.event.type === "final" &&
				event.event.content === "Native partial complete.",
		),
	);
	run = await start("native-smoke:stream-cancel");
	await until(
		() =>
			events.some(
				(event) =>
					event.run_id === run &&
					event.event.type === "text.stream" &&
					event.event.phase === "delta",
			),
		"cancel scenario has real live partial text",
	);
	await rpc("run.cancel", { run_id: run });
	await done(run);
	assert.equal(statuses.get(run), "cancelled");
	assert(
		!events.some(
			(event) =>
				event.run_id === run &&
				(event.event.type === "final" ||
					(event.event.type === "text.stream" &&
						event.event.phase === "commit")),
		),
		"cancelled live response must not commit",
	);
	writeFileSync(
		`${fixture}/stream-cancel-release`,
		"release cancelled fixture response",
	);
	holdChildApproval = true;
	run = await start("native-smoke:child-approval");
	await until(() => !!childApproval, "structured child approval");
	await done(run);
	assert.equal(statuses.get(run), "completed");
	assert(childApproval);
	assert.equal(
		(await rpc<TaskInfo>("task.status", { task_id: childApproval.taskId }))
			.state,
		"running",
	);
	assert(
		!cancelledRequests.has(childApproval.requestId),
		"parent completion must not abort child approval",
	);
	await rpc("task.cancel", { task_id: childApproval.taskId });
	await until(
		() => cancelledRequests.has(childApproval?.requestId ?? ""),
		"child cancellation closes its UI request",
	);
	assert(!existsSync(`${fixture}/workspace/child-approved.txt`));
	holdChildApproval = false;
	const sessions = await rpc<SessionListResult>("session.list", {
		scope: "current_workspace",
		limit: 100,
	});
	assert(sessions.sessions.some((item) => item.session_id === session));
	const before = events.length;
	await rpc("session.history", {
		session_id: session,
		max_runs: 40,
		max_events: 2500,
	});
	assert(events.length > before);
	assert(
		!events.slice(before).some((event) => event.event.type === "text.stream"),
		"history replays canonical events without partial attempts",
	);
} catch (error) {
	scenarioError = error;
	console.error("Scenario failure:", error);
} finally {
	runtime?.stdin?.end();
	writeFileSync(`${fixture}/provider-stop`, "fixture self-stop");
	for (
		let n = 0;
		n < 500 && (runtime?.exitCode === null || provider.exitCode === null);
		n++
	)
		await Bun.sleep(50);
	if (provider.exitCode === null || runtime?.exitCode === null) {
		if (!scenarioError)
			cleanupError = new Error(
				"Owned fixture processes did not exit without signals",
			);
		console.error(
			`Cleanup incomplete: provider=${provider.pid}/${provider.exitCode}, runtime=${runtime?.pid}/${runtime?.exitCode}`,
		);
	}
}

if (scenarioError) throw scenarioError;
if (cleanupError) throw cleanupError;
console.log(
	"PASS: real runtime initialize, deny/allow-once writes without saved permission rules, client tool, existing subagent, two running children + parent approval, separate parent/child stop, child approval outlives parent and cancels by exact request ID, provider error/recovery, genuine live SSE before completion with canonical history replay, sessions and history",
);
