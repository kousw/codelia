import { Agent } from "@codelia/core";
import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskRegistryStore } from "@codelia/storage";
import { createAgentFactory } from "../src/agent-factory";
import { createToolContext } from "../src/rpc/tool";
import { RuntimeState } from "../src/runtime-state";
import type { SubagentLaunchInput } from "../src/subagents/contracts";
import { AgentTreeCoordinator } from "../src/subagents/coordinator";
import { TaskManager } from "../src/tasks";

for (const mode of ["allow", "deny-rule", "deny-stop", "deny-reason"] as const)
	test(`composed task tool enforces delegation approval: ${mode}`, async () => {
		const allow = mode === "allow";
		const confirm = mode === "deny-stop" || mode === "deny-reason";
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-subagent-composition-"),
		);
		const tasks = new TaskManager({
			registry: new TaskRegistryStore(path.join(root, "tasks")),
		});
		let launches = 0;
		let profileLoads = 0;
		let credentialLoads = 0;
		const selectedModels: SubagentLaunchInput["model"][] = [];
		const delegatedPermissions: SubagentLaunchInput["permission"][] = [];
		const tree = new AgentTreeCoordinator(tasks, {
			isAvailable: () => true,
			prepare(input) {
				selectedModels.push(input.model);
				delegatedPermissions.push(input.permission);
				let resolve!: (r: import("../src/tasks").TaskExecutionResult) => void;
				const wait = new Promise<import("../src/tasks").TaskExecutionResult>(
					(r) => {
						resolve = r;
					},
				);
				return {
					wait,
					async cancel() {
						resolve({ state: "cancelled" });
					},
					async start(control) {
						launches++;
						await control.running({ child_session_id: "child" });
						resolve({
							state: "completed",
							result: { termination_reason: "normal", summary: "done" },
						});
					},
				};
			},
		});
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			environment: {
				contract: {
					workspace: { root, filesystem: "enabled", process: "runtime" },
					context: {
						systemPrompt: "host",
						projectInstructions: "disabled",
						skills: "disabled",
						executionEnvironment: "disabled",
					},
					auth: { model: "host" },
					config: { source: "host" },
					tools: {
						builtin: "none",
						search: "disabled",
						mcp: "disabled",
						host: "disabled",
					},
					persistence: { mode: "volatile" },
					events: { live: "host" },
				},
			},
			adapters: {
				systemPromptProvider: { loadSystemPrompt: () => "Test parent" },
				configProvider: {
					resolveSubagentConfig: async () => {
						profileLoads++;
						return {
							default_profile: "research",
							profiles: {
								research: {
									description: "Investigate the problem",
									model: {
										provider: "openrouter",
										name: "vendor/research-model",
									},
								},
								review: {
									model: { provider: "anthropic", name: "review-model" },
								},
							},
						};
					},
					resolveModelConfig: async () => ({
						provider: "openai",
						name: "gpt-5",
					}),
					resolvePermissionsConfig: async () =>
						confirm
							? {}
							: allow
								? { allow: [{ tool: "task_spawn" }] }
								: { deny: [{ tool: "task_spawn" }] },
				},
				credentialProvider: {
					resolveProvider: async () => "openai",
					resolveProviderAuth: async () => {
						credentialLoads++;
						return { method: "api_key", api_key: "test-no-network" };
					},
				},
				eventSink: { emit: () => {} },
				stores: { taskManager: tasks },
			},
		});
		state.sessionId = "parent";
		state.setUiCapabilities({ supports_confirm: true });
		let confirmations = 0;
		const output = confirm
			? spyOn(process.stdout, "write").mockImplementation((chunk) => {
					const message = JSON.parse(String(chunk));
					if (message.method === "ui.confirm.request") {
						confirmations++;
						state.resolveUiResponse({
							jsonrpc: "2.0",
							id: message.id,
							result: {
								ok: false,
								...(mode === "deny-reason"
									? { reason: "Please do the research yourself" }
									: {}),
							},
						});
					}
					return true;
				})
			: undefined;
		try {
			await createAgentFactory(state, {
				taskManager: tasks,
				subagents: tree,
			})();
			const spawn = state.tools?.find((t) => t.name === "task_spawn");
			if (!spawn) throw new Error("Task tool not composed");
			if (mode === "deny-stop") {
				const invalid = {
					name: "MapleScope",
					prompt: "Read-only repository research",
					workspace_access: "read-only" as const,
					tool_allowlist: [
						"read",
						"read_line",
						"list_files",
						"search_files",
						"shell",
					],
				};
				const runtimeSpawn = state.subagentSpawn;
				if (!runtimeSpawn) throw new Error("Missing shared spawn gate");
				await expect(
					runtimeSpawn({ ...invalid, kind: "subagent" }, createToolContext()),
				).rejects.toThrow("read-only does not allow: shell");
				await expect(async () =>
					spawn.executeRaw(JSON.stringify(invalid), createToolContext()),
				).toThrow("Omit tool_allowlist");
				expect(confirmations).toBe(0);
				expect(delegatedPermissions).toHaveLength(0);
				expect(await tree.list("parent")).toHaveLength(0);
			}
			if (allow) {
				if (!("parameters" in spawn.definition))
					throw new Error("Expected a function tool");
				expect(spawn.definition.parameters.properties?.name).not.toHaveProperty(
					"pattern",
				);
				const result = await spawn.executeRaw(
					'{"name":"Copper Finch","prompt":"read-only research","workspace_access":"read-only"}',
					createToolContext(),
				);
				expect(result.type).toBe("text");
				const task = (await tree.list("parent"))[0];
				await tasks.wait(task.task_id);
				expect(launches).toBe(1);
				expect(delegatedPermissions[0].workspace_access).toBe("read-only");
				expect(delegatedPermissions[0].tool_allowlist).toEqual([
					"read",
					"read_line",
					"list_files",
					"search_files",
				]);
				expect(task.parent_session_id).toBe("parent");
				expect(selectedModels[0]).toEqual({
					provider: "openrouter",
					name: "vendor/research-model",
				});
				expect(state.systemPrompt).toContain("Investigate the problem");
				await spawn.executeRaw(
					JSON.stringify({
						name: "Reviewer",
						prompt: "review",
						profile: "review",
					}),
					createToolContext(),
				);
				await spawn.executeRaw(
					JSON.stringify({
						name: "Direct",
						prompt: "user-directed",
						model: { provider: "xai", name: "user-chosen-model" },
					}),
					createToolContext(),
				);
				expect(selectedModels.slice(1)).toEqual([
					{ provider: "anthropic", name: "review-model" },
					{ provider: "xai", name: "user-chosen-model" },
				]);
				expect(profileLoads).toBe(1);
				expect(credentialLoads).toBe(1);
			} else if (confirm) {
				let calls = 0;
				const agent = new Agent({
					tools: state.tools ?? [],
					llm: {
						provider: "openai",
						model: "gpt-5",
						async ainvoke() {
							calls++;
							return {
								messages: [
									calls === 1
										? {
												role: "assistant" as const,
												content: null,
												tool_calls: [
													{
														id: "delegate",
														type: "function" as const,
														function: {
															name: "task_spawn",
															arguments:
																'{"name":"Copper Finch","prompt":"research"}',
														},
													},
												],
											}
										: {
												role: "assistant" as const,
												content: "Continuing with the requested alternative",
											},
								],
							};
						},
					},
				});
				const result = await agent.run("Research this");
				expect(confirmations).toBe(1);
				expect(calls).toBe(mode === "deny-stop" ? 1 : 2);
				expect(result).toContain(
					mode === "deny-stop" ? "Turn stopped" : "Continuing",
				);
				expect(JSON.stringify(agent.getHistoryMessages())).toContain(
					mode === "deny-stop"
						? "permission denied"
						: "Please do the research yourself",
				);
				expect(launches).toBe(0);
				expect(await tree.list("parent")).toHaveLength(0);
			} else {
				await expect(
					spawn.executeRaw(
						'{"name":"Copper Finch","prompt":"read-only research"}',
						createToolContext(),
					),
				).rejects.toThrow("denied");
				expect(launches).toBe(0);
				expect(await tree.list("parent")).toHaveLength(0);
			}
		} finally {
			output?.mockRestore();
			await tasks.shutdown();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
