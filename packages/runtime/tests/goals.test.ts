import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	type BaseChatModel,
	type ChatInvokeInput,
	type RunEventStoreFactory,
	type SessionState,
} from "@codelia/core";
import {
	type AgentEventNotify,
	RPC_ERROR_CODE,
	type RpcNotification,
	type RpcResponse,
} from "@codelia/protocol";
import type { GoalOffer, GoalSnapshot } from "@codelia/shared-types";
import {
	resolveStoragePaths,
	SessionStateStoreImpl,
	SessionStoreWriterImpl,
} from "@codelia/storage";
import { createRuntimeToolApproval } from "../src/permissions/tool-approval";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { type RuntimeModelOverride, RuntimeState } from "../src/runtime-state";
import { VolatileRunEventStoreFactory } from "../src/volatile-stores";

const usage = {
	model: "fixture",
	input_tokens: 30,
	input_cached_tokens: 20,
	output_tokens: 5,
	total_tokens: 35,
};
const reply: Awaited<ReturnType<BaseChatModel["ainvoke"]>> = {
	messages: [{ role: "assistant", content: "Fixture work finished." }],
	usage,
};

const deadlineMs = 3000;
async function waitFor<T>(inspect: () => T | undefined): Promise<T> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const value = inspect();
		if (value !== undefined) return value;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for runtime");
}

let temp: string;
let store: SessionStateStoreImpl;
let wire: Array<RpcNotification | RpcResponse>;
let requestId: number;
const originalWrite = process.stdout.write;

beforeEach(async () => {
	temp = await mkdtemp(join(tmpdir(), "codelia-goals-"));
	store = new SessionStateStoreImpl({
		paths: resolveStoragePaths({ rootOverride: temp }),
	});
	wire = [];
	requestId = 0;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		wire.push(JSON.parse(String(chunk)));
		return true;
	}) as typeof process.stdout.write;
});

afterEach(async () => {
	process.stdout.write = originalWrite;
	await rm(temp, { recursive: true, force: true });
});

class FailingCheckpointStore extends SessionStateStoreImpl {
	override async save(state: SessionState): Promise<void> {
		if (state.run_id) throw new Error("fixture checkpoint write failed");
		await super.save(state);
	}
}

function runtime(
	ainvoke: BaseChatModel["ainvoke"] = async () => reply,
	sessionStore = store,
	beforeGetAgent?: () => Promise<void>,
	maxIterations?: number,
	runEventStoreFactory: RunEventStoreFactory = new VolatileRunEventStoreFactory(),
) {
	const state = new RuntimeState();
	state.setUiCapabilities({ supports_goals: true });
	const approval = createRuntimeToolApproval({
		state,
		builtinNames: new Set(["update_goal"]),
	});
	state.wrapGoalTool = (tool) => approval.wrap(tool, "builtin");
	const handlers = createRuntimeHandlers({
		state,
		log: () => {},
		sessionStateStore: sessionStore,
		runEventStoreFactory,
		getAgent: async () => {
			await beforeGetAgent?.();
			state.agent ??= new Agent({
				llm: { provider: "openai", model: "fixture", ainvoke },
				tools: [],
				systemPrompt: "Fixture",
				compaction: null,
				toolOutputCache: null,
				maxIterations,
			});
			return state.agent;
		},
	});
	return {
		state,
		async request(method: string, params: object = {}): Promise<RpcResponse> {
			const id = String(++requestId);
			handlers.processMessage({ jsonrpc: "2.0", id, method, params });
			return waitFor(() =>
				wire.find(
					(message): message is RpcResponse =>
						"id" in message && message.id === id,
				),
			);
		},
	};
}

type Fixture = ReturnType<typeof runtime>;
function notifications(method: string) {
	return wire.filter(
		(message): message is RpcNotification =>
			"method" in message && message.method === method,
	);
}

function visibleToolResults(replayed = false) {
	return notifications("agent.event")
		.map(({ params }) => params as AgentEventNotify)
		.filter(({ meta }) => Boolean(meta?.replayed) === replayed)
		.map(({ event }) => event)
		.filter((event) => event.type === "tool_result");
}

async function setGoal(fixture: Fixture, tokenBudget?: number) {
	const response = await fixture.request("goal.set", {
		objective: "Verify the fixture result",
		token_budget: tokenBudget,
	});
	expect(response.error).toBeUndefined();
	const goal = (response.result as GoalSnapshot).goal;
	if (!goal) throw new Error("Goal was not created");
	return goal;
}

async function offer(index = 0): Promise<GoalOffer> {
	return waitFor(
		() => notifications("goal.ready")[index]?.params as GoalOffer | undefined,
	);
}

async function settled(fixture: Fixture): Promise<void> {
	await waitFor(() => (fixture.state.activeRunId === null ? true : undefined));
}

describe("local TUI goal lifecycle", () => {
	test("an automatic continuation uses the user-set objective as approval intent", async () => {
		const captured: unknown[] = [];
		const fixture = runtime(async () => {
			const runId = fixture.state.activeRunId;
			if (!runId) throw new Error("Expected an active goal continuation");
			captured.push(fixture.state.approvalUserIntent(runId));
			return reply;
		});
		await setGoal(fixture);
		expect(
			(await fixture.request("goal.continue", await offer())).error,
		).toBeUndefined();
		await settled(fixture);
		expect(captured).toEqual([
			{ original: "Verify the fixture result", corrections: [] },
		]);
	});

	test("a TUI Steer after bang remains ordered across automatic runs and objective edits", async () => {
		const captured: unknown[] = [];
		const first = Promise.withResolvers<void>();
		const fixture = runtime(async () => {
			const runId = fixture.state.activeRunId;
			if (!runId) throw new Error("Expected goal run");
			captured.push(fixture.state.approvalUserIntent(runId));
			if (captured.length === 1) await first.promise;
			return reply;
		});
		fixture.state.lastClientInfo = { name: "codelia-tui", version: "fixture" };
		await setGoal(fixture);
		const started = await fixture.request("goal.continue", await offer());
		const { run_id } = started.result as { run_id: string };
		const restriction = "Keep working, but do not run the fixture script.";
		try {
			const steer = await fixture.request("run.steer", {
				run_id,
				input: {
					type: "text",
					text: `<shell_result>\n{"id":"bang","command_preview":"fixture","stdout":"private fixture output"}\n</shell_result>\n\n${restriction}`,
				},
			});
			expect(steer.error).toBeUndefined();
		} finally {
			first.resolve();
		}
		await settled(fixture);
		expect(
			notifications("agent.event").map(
				({ params }) => (params as AgentEventNotify).event.type,
			),
		).toContain("steer_applied");
		expect(
			(await fixture.request("goal.continue", await offer(1))).error,
		).toBeUndefined();
		await settled(fixture);
		expect(captured.at(-1)).toEqual({
			original: "Verify the fixture result",
			corrections: [restriction],
		});
		const current = ((await fixture.request("goal.get")).result as GoalSnapshot)
			.goal;
		if (!current) throw new Error("Expected an active goal to edit");
		const replacement = "Run the fixture script once, then verify the result.";
		expect(
			(
				await fixture.request("goal.set", {
					session_id: current.session_id,
					goal_id: current.goal_id,
					revision: current.revision,
					objective: replacement,
				})
			).error,
		).toBeUndefined();
		expect(
			(await fixture.request("goal.continue", await offer(3))).error,
		).toBeUndefined();
		await settled(fixture);
		expect(captured.at(-1)).toEqual({
			original: replacement,
			earlierGoalSteers: [restriction],
			corrections: [],
		});
	});

	test("rejects an unregistered goal tool and releases its run reservation", async () => {
		let calls = 0;
		const fixture = runtime(async () => {
			calls++;
			return reply;
		});
		const goal = await setGoal(fixture);
		const ready = await offer();
		fixture.state.wrapGoalTool = undefined;

		const started = await fixture.request("goal.continue", ready);

		expect(started.error?.code).toBe(RPC_ERROR_CODE.RUNTIME_INTERNAL);
		expect(calls).toBe(0);
		expect(fixture.state.activeRunId).toBeNull();
		const snapshot = (
			await fixture.request("goal.get", { session_id: goal.session_id })
		).result as GoalSnapshot;
		expect(snapshot.active_run_id).toBeUndefined();
	});

	test("reserves one run, records usage, and reconciles the same receipt", async () => {
		const fixture = runtime();
		const goal = await setGoal(fixture);
		expect((await store.load(goal.session_id))?.messages).toEqual([]);
		const ready = await offer();
		const started = await fixture.request("goal.continue", ready);
		const duplicate = await fixture.request("goal.continue", ready);
		expect(duplicate.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS);
		await settled(fixture);
		const runId = (started.result as { run_id: string }).run_id;
		const live = await offer(1);
		expect(live.after_run_id).toBe(runId);
		const terminalIndex = wire.findIndex(
			(message) =>
				"method" in message &&
				message.method === "run.status" &&
				(message.params as { status?: string }).status === "completed",
		);
		expect(terminalIndex).toBeGreaterThan(-1);
		expect(terminalIndex).toBeLessThan(
			wire.findIndex(
				(message) =>
					"method" in message &&
					message.method === "goal.ready" &&
					message.params === live,
			),
		);
		const reconciled = (await fixture.request("goal.get", ready))
			.result as GoalSnapshot;
		expect(reconciled.accepted_run_id).toBe(runId);
		expect(reconciled.active_run_id).toBeUndefined();
		expect(reconciled.goal).toMatchObject({
			tokens_used: 15,
			usage_known: true,
			automatic_runs: 1,
		});
		const saved = await store.load(goal.session_id);
		expect(saved?.messages.some((message) => message.role === "user")).toBe(
			false,
		);
	});

	test("preserves the selected model through fresh goal creation and first continuation", async () => {
		const selected = {
			provider: "openai",
			name: "gpt-6.1-sol",
			reasoning: "high",
			fast: true,
		} as const;
		const seenModels: Array<RuntimeModelOverride | null> = [];
		const fixture = runtime(
			async () => reply,
			store,
			async () => {
				seenModels.push(fixture.state.sessionModelOverride);
			},
		);
		fixture.state.sessionModelOverride = selected;
		fixture.state.runtimeSandboxRoot = temp;

		const goal = await setGoal(fixture);
		expect((await store.load(goal.session_id))?.meta).toMatchObject({
			codelia_model_override: selected,
			codelia_workspace_root: temp,
		});
		expect(
			(await fixture.request("goal.continue", await offer())).error,
		).toBeUndefined();
		await settled(fixture);
		expect(seenModels).toEqual([selected]);
	});

	test("reopens without arming and prevents another runtime from taking over a live claim", async () => {
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = runtime(async () => {
			await waiting;
			return reply;
		});
		const goal = await setGoal(first);
		const secondStore = new SessionStateStoreImpl({
			paths: { ...resolveStoragePaths(), sessionsDir: join(temp, "sessions") },
		});
		const second = runtime(undefined, secondStore);
		expect(
			(await second.request("session.open", { session_id: goal.session_id }))
				.error,
		).toBeUndefined();
		expect((await second.request("goal.get")).result).toMatchObject({
			goal,
			can_continue: false,
		});
		expect(notifications("goal.ready")).toHaveLength(1);

		const start = await first.request("goal.continue", await offer());
		expect(start.error).toBeUndefined();
		try {
			expect((await second.request("goal.resume", goal)).error?.code).toBe(
				RPC_ERROR_CODE.RUNTIME_BUSY,
			);
		} finally {
			release();
			await settled(first);
		}
		const resumed = (await second.request("goal.resume", goal))
			.result as GoalSnapshot;
		expect(resumed.can_continue).toBe(true);
		expect(resumed.goal?.activation_id).not.toBe(goal.activation_id);
		const stale = await first.request("goal.continue", await offer(1));
		expect(stale.error).toBeDefined();
	});

	test("interrupts a matching continuation and keeps unresolved usage", async () => {
		let entered = false;
		const fixture = runtime(async ({ signal }) => {
			entered = true;
			await new Promise<void>((_resolve, reject) => {
				if (signal?.aborted) return reject(signal.reason);
				signal?.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
			return reply;
		});
		const goal = await setGoal(fixture, 50);
		const ready = await offer();
		expect(
			(await fixture.request("goal.continue", ready)).error,
		).toBeUndefined();
		await waitFor(() => (entered ? true : undefined));
		const paused = (
			await fixture.request("goal.pause", {
				...goal,
				continuation_id: ready.continuation_id,
			})
		).result as GoalSnapshot;
		expect(paused).toMatchObject({
			goal: { status: "paused", stop_reason: "user" },
			can_continue: false,
		});
		await settled(fixture);
		const saved = (await fixture.request("goal.get")).result as GoalSnapshot;
		expect(saved.goal).toMatchObject({ status: "paused", usage_known: false });
		if (!saved.goal) throw new Error("Paused goal is missing");
		expect(
			(await fixture.request("goal.resume", saved.goal)).result,
		).toMatchObject({
			goal: { status: "usage_limited" },
			can_continue: false,
		});
		expect(notifications("run.status").at(-1)?.params).toMatchObject({
			status: "cancelled",
		});
		expect(notifications("goal.ready")).toHaveLength(1);
	});

	test("latches pause while continuation is in asynchronous preflight", async () => {
		let preparing = false;
		let release!: () => void;
		const preflight = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fixture = runtime(
			async () => {
				throw new Error("Model must not start");
			},
			store,
			async () => {
				preparing = true;
				await preflight;
			},
		);
		const goal = await setGoal(fixture);
		const ready = await offer();
		const starting = fixture.request("goal.continue", ready);
		await waitFor(() => (preparing ? true : undefined));
		const pausing = fixture.request("goal.pause", {
			...goal,
			continuation_id: ready.continuation_id,
		});
		release();
		expect((await starting).error).toBeDefined();
		expect((await pausing).result).toMatchObject({
			goal: { status: "paused", automatic_runs: 0 },
		});
		expect(notifications("run.status")).toHaveLength(0);
	});

	test("revokes a pending continuation when the requested session changes", async () => {
		let working = false;
		let release!: () => void;
		const preflight = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fixture = runtime(
			async () => {
				throw new Error("Model must not start");
			},
			store,
			async () => {
				working = true;
				await preflight;
			},
		);
		const goal = await setGoal(fixture);
		await store.save({
			session_id: "next-session",
			schema_version: 1,
			updated_at: new Date().toISOString(),
			messages: [],
		});
		const starting = fixture.request("goal.continue", await offer());
		await waitFor(() => (working ? true : undefined));
		const opening = fixture.request("session.open", {
			session_id: "next-session",
		});
		release();
		expect((await starting).error).toBeDefined();
		expect((await opening).result).toEqual({ session_id: "next-session" });
		expect(notifications("run.status")).toHaveLength(0);
		expect((await store.goals.read(goal.session_id)).entry?.goal.status).toBe(
			"active",
		);
	});

	test("reconciles a dead runtime marker without discarding measured usage", async () => {
		const fixture = runtime();
		const goal = await setGoal(fixture, 100);
		const dead = Bun.spawn([process.execPath, "-e", ""]);
		await dead.exited;
		await store.goals.update(goal.session_id, ({ entry }) => {
			if (!entry) throw new Error("No goal");
			entry.goal.tokens_used = 15;
			entry.claim = {
				run_id: "interrupted",
				revision: goal.revision,
				activation_id: goal.activation_id,
				owner_pid: dead.pid,
				owner_identity: null,
				pending_seq: 2,
				accounted_seq: 1,
			};
		});
		const other = runtime();
		await other.request("session.open", { session_id: goal.session_id });
		expect((await other.request("goal.resume", goal)).result).toMatchObject({
			goal: { status: "usage_limited", tokens_used: 15, usage_known: false },
			can_continue: false,
		});
		expect(
			(await store.goals.read(goal.session_id)).entry?.claim,
		).toBeUndefined();
	});

	test("stops after crossing the budget and after three automatic starts", async () => {
		const budgeted = runtime();
		await setGoal(budgeted, 10);
		await budgeted.request("goal.continue", await offer());
		await settled(budgeted);
		expect((await budgeted.request("goal.get")).result).toMatchObject({
			can_continue: false,
			goal: { status: "budget_limited", tokens_used: 15 },
		});
		expect(notifications("goal.ready")).toHaveLength(1);

		const unlimited = runtime(async ({ messages }) => {
			expect(messages.at(-1)?.role).toBe("user");
			return reply;
		});
		await setGoal(unlimited);
		for (let index = 1; index <= 3; index++) {
			expect(
				(await unlimited.request("goal.continue", await offer(index))).error,
			).toBeUndefined();
			await settled(unlimited);
		}
		expect((await unlimited.request("goal.get")).result).toMatchObject({
			can_continue: false,
			goal: { status: "paused", stop_reason: "turn_limit", tokens_used: 45 },
		});
		expect(notifications("goal.ready")).toHaveLength(4);
	});

	test("stops with the obstacle after three matching blocker reports", async () => {
		let calls = 0;
		const fixture = runtime(async () => {
			calls += 1;
			if (calls % 2 === 0) return reply;
			return {
				usage,
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: `blocked-${calls}`,
								type: "function",
								function: {
									name: "update_goal",
									arguments: JSON.stringify({
										status: "blocked",
										blocker_key: "missing-fixture",
										evidence: "Fixture file is unavailable.",
									}),
								},
							},
						],
					},
				],
			};
		});
		await setGoal(fixture);
		for (let index = 0; index < 3; index++) {
			expect(
				(await fixture.request("goal.continue", await offer(index))).error,
			).toBeUndefined();
			await settled(fixture);
		}
		expect((await fixture.request("goal.get")).result).toMatchObject({
			can_continue: false,
			goal: {
				status: "blocked",
				stop_detail: "Fixture file is unavailable.",
				tokens_used: 90,
			},
		});
	});

	test.each(["manual", "automatic"] as const)(
		"places %s goal context at the run boundary through tool steps and max-iterations summary",
		async (mode) => {
			const inputs: ChatInvokeInput[] = [];
			const fixture = runtime(
				async (input) => {
					inputs.push(input);
					if (inputs.length === 1 || input.tools === null) return reply;
					return {
						usage,
						messages: [
							{
								role: "assistant",
								content: "",
								tool_calls: [
									{
										id: `read-${inputs.length}`,
										type: "function",
										function: { name: "get_goal", arguments: "{}" },
									},
								],
							},
						],
					};
				},
				store,
				undefined,
				2,
			);
			expect(
				(
					await fixture.request("run.start", {
						input: { type: "text", text: "Prior user request" },
					})
				).error,
			).toBeUndefined();
			await settled(fixture);
			const goal = await setGoal(fixture);
			const start =
				mode === "manual"
					? await fixture.request("run.start", {
							input: { type: "text", text: "Newest user instruction" },
						})
					: await fixture.request("goal.continue", await offer());
			expect(start.error).toBeUndefined();
			await settled(fixture);

			const objective =
				mode === "manual"
					? "Session goal"
					: "Continue work on the session goal";
			const context = `${objective} (follow newer user instructions): "Verify the fixture result".`;
			const prefix: ChatInvokeInput["messages"] = [
				{ role: "system", content: "Fixture" },
				{ role: "user", content: "Prior user request" },
				...reply.messages,
				{ role: "user", content: context },
				...(mode === "manual"
					? [{ role: "user" as const, content: "Newest user instruction" }]
					: []),
			];
			expect(inputs).toHaveLength(4);
			const [, first, afterTool, summary] = inputs;
			expect(first.messages).toEqual(prefix);
			expect(afterTool.messages.slice(0, prefix.length)).toEqual(prefix);
			expect(afterTool.messages.at(-1)).toMatchObject({
				role: "tool",
				content: expect.stringContaining(goal.goal_id),
			});
			expect(visibleToolResults()).toContainEqual(
				expect.objectContaining({
					tool: "get_goal",
					result: "Goal (active)\nVerify the fixture result",
				}),
			);
			expect(summary.messages.slice(0, prefix.length)).toEqual(prefix);
			expect(summary.messages.at(-1)?.content).toContain("max iterations");
			expect(summary.tools).toBeNull();
			expect(summary.toolChoice).toBe("none");

			const archive = await store.searchMessages(goal.session_id, {
				query: "follow newer user instructions",
			});
			expect(archive.matches).toEqual([]);
			const saved = await store.load(goal.session_id);
			expect(
				saved?.messages
					.filter((message) => message.role === "user")
					.map((message) => message.content),
			).toEqual(
				mode === "manual"
					? ["Prior user request", "Newest user instruction"]
					: ["Prior user request"],
			);
		},
	);

	test("applies a verified completion report only after saving the checkpoint", async () => {
		const makeAgent = (): BaseChatModel["ainvoke"] => {
			let calls = 0;
			return async (input) => {
				const reportTool = input.tools?.find(
					(tool) => "name" in tool && tool.name === "update_goal",
				);
				expect(
					reportTool && "description" in reportTool && reportTool.description,
				).toContain("before giving your final answer");
				const reportFields =
					reportTool && "parameters" in reportTool
						? reportTool.parameters.properties
						: undefined;
				const { status, blocker_key: blockerKey } = reportFields ?? {};
				expect(status).toMatchObject({ enum: ["complete", "blocked"] });
				expect(typeof status === "object" && status.description).toContain(
					"verifying every goal requirement",
				);
				expect(
					typeof blockerKey === "object" && blockerKey.description,
				).toContain("Reuse the same short key");
				if (calls++ > 0) {
					expect(input.messages.slice(-2)).toEqual([
						expect.objectContaining({
							tool_name: "update_goal",
							is_error: true,
							content: "Error: blocked requires blocker_key",
						}),
						expect.objectContaining({
							tool_name: "update_goal",
							content: JSON.stringify({
								recorded: true,
								applied_after_successful_finalization: true,
							}),
						}),
					]);
					return reply;
				}
				return {
					usage,
					messages: [
						{
							role: "assistant",
							content: "",
							tool_calls: [
								{
									id: "inspect-goal",
									type: "function",
									function: { name: "get_goal", arguments: "{}" },
								},
								{
									id: "missing-key",
									type: "function",
									function: {
										name: "update_goal",
										arguments: JSON.stringify({
											status: "blocked",
											evidence: "An obstacle.",
										}),
									},
								},
								{
									id: "report",
									type: "function",
									function: {
										name: "update_goal",
										arguments: JSON.stringify({
											status: "complete",
											evidence: "Verified fixture result.",
										}),
									},
								},
							],
						},
					],
				};
			};
		};
		let terminalWrite: Promise<void> | undefined;
		const fixture = runtime(makeAgent(), store, undefined, undefined, {
			create: ({ runId, startedAt }) => {
				const writer = new SessionStoreWriterImpl({
					runId,
					startedAt,
					paths: resolveStoragePaths({ rootOverride: temp }),
					runIndex: store,
					dump: false,
				});
				return {
					append: (record) => {
						const write = writer.append(record);
						if (record.type === "run.end") terminalWrite = write;
						return write;
					},
				};
			},
		});
		const goal = await setGoal(fixture);
		await fixture.request("goal.continue", await offer());
		await settled(fixture);
		expect((await fixture.request("goal.get")).result).toMatchObject({
			can_continue: false,
			goal: { status: "complete", tokens_used: 30 },
		});
		const liveResults = visibleToolResults();
		expect(liveResults).toMatchObject([
			{
				tool: "get_goal",
				result: "Goal (active)\nVerify the fixture result",
			},
			{
				tool: "update_goal",
				result: "Error: blocked requires blocker_key",
				is_error: true,
			},
			{
				tool: "update_goal",
				result:
					"Completion report recorded for evaluation after successful finalization.\nVerified fixture result.",
			},
		]);
		await waitFor(() => terminalWrite);
		expect(
			(
				await fixture.request("session.history", {
					session_id: goal.session_id,
				})
			).error,
		).toBeUndefined();
		expect(visibleToolResults(true)).toEqual(liveResults);

		const failing = new FailingCheckpointStore({
			paths: resolveStoragePaths({ rootOverride: join(temp, "failing") }),
		});
		const failure = runtime(makeAgent(), failing);
		await setGoal(failure);
		await failure.request("goal.continue", await offer(1));
		await settled(failure);
		expect((await failure.request("goal.get")).result).toMatchObject({
			can_continue: false,
			goal: { status: "paused", stop_reason: "checkpoint_failed" },
		});
		expect(notifications("goal.ready")).toHaveLength(2);
	});
});
