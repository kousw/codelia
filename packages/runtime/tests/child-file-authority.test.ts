import { expect, test } from "bun:test";
import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskRegistryStore } from "@codelia/storage";
import { createAgentFactory } from "../src/agent-factory";
import { runtimeEnvironmentPresets } from "../src/environment";
import { runtimeFileMutations } from "../src/permissions/runtime-approval";
import { createRuntimeToolApproval } from "../src/permissions/tool-approval";
import { createToolContext } from "../src/rpc/tool";
import { RuntimeState } from "../src/runtime-state";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import type { SubagentChannel } from "../src/subagents/contracts";
import { AgentTreeCoordinator } from "../src/subagents/coordinator";
import { createSubagentReadTools } from "../src/subagents/read-tools";
import { type TaskExecutionResult, TaskManager } from "../src/tasks";
import { createApplyPatchTool } from "../src/tools/apply-patch";
import { createWriteTool } from "../src/tools/write";
import { approveFixture, fixtureShellBackend } from "./fixtures/approval";

test("child reads, listings and search share the parent's SDK file authority through revocation", async () => {
	const base = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), "codelia-file-scope-")),
	);
	const root = path.join(base, "workspace");
	const visible = path.join(root, "visible.txt");
	const hidden = path.join(root, "hidden.txt");
	const outside = path.join(base, "unrelated.txt");
	const tasks = new TaskManager({
		registry: new TaskRegistryStore(path.join(base, "tasks")),
	});
	let childChannel: SubagentChannel | undefined;
	const tree = new AgentTreeCoordinator(tasks, {
		isAvailable: () => true,
		prepare(input, channel) {
			childChannel = channel;
			let settle!: (result: TaskExecutionResult) => void;
			const wait = new Promise<TaskExecutionResult>((resolve) => {
				settle = resolve;
			});
			return {
				wait,
				async start(control) {
					await control.running({ child_session_id: input.task_id });
				},
				async cancel() {
					settle({ state: "cancelled" });
				},
			};
		},
	});
	const state = new RuntimeState();
	let revision = 0;
	let revoked = false;
	let revokeOnSelection = false;
	try {
		await fs.mkdir(root);
		await Promise.all([
			fs.writeFile(visible, "matching public fixture\n"),
			fs.writeFile(hidden, "matching hidden fixture\n"),
			fs.writeFile(outside, "matching unrelated fixture\n"),
		]);
		const preset = runtimeEnvironmentPresets["tui-local"];
		state.setRuntimeEnvironment({
			environment: {
				contract: {
					...preset,
					workspace: { ...preset.workspace, root },
					context: {
						systemPrompt: "host",
						projectInstructions: "from-workspace",
						skills: "from-config",
						executionEnvironment: "disabled",
					},
					config: { source: "host" },
					auth: { model: "host" },
					tools: { ...preset.tools, mcp: "disabled", search: "disabled" },
					persistence: { mode: "volatile" },
					events: { live: "host" },
				},
			},
			adapters: {
				systemPromptProvider: {
					loadSystemPrompt: () => "File authority fixture",
				},
				configProvider: {
					resolveSkillsConfig: async () => ({
						enabled: false,
						initial: { maxEntries: 5, maxBytes: 1024 },
						search: { defaultLimit: 10, maxLimit: 10 },
					}),
					resolveModelConfig: async () => ({
						provider: "openai",
						name: "gpt-5",
					}),
				},
				credentialProvider: {
					resolveProvider: async () => "openai",
					resolveProviderAuth: async () => ({
						method: "api_key",
						api_key: "no-network-fixture",
					}),
				},
				approvalService: approveFixture,
				approvalPolicyRevision: () => String(revision),
				approvalToolAuthority: ({ name }) => {
					if (name !== "read") return undefined;
					const resources = [
						{ operation: "invoke", target: name } as const,
						...(!revoked
							? [{ operation: "read", target: visible } as const]
							: []),
					];
					if (revokeOnSelection) {
						revokeOnSelection = false;
						revoked = true;
						revision++;
					}
					return {
						ceiling: resources,
						granted: resources,
						launchRule: "fixture",
					};
				},
				eventSink: { emit: () => {} },
				stores: { taskManager: tasks },
			},
		});
		state.sessionId = "file-owner";
		await createAgentFactory(state, { subagents: tree, taskManager: tasks })();
		const parent = state.tools?.find((tool) => tool.name === "read");
		const parentLine = state.tools?.find((tool) => tool.name === "read_line");
		if (!parent || !parentLine) throw new Error("missing parent file tool");
		const readWith = (tool: typeof parent, file_path: string) =>
			tool.executeRaw(JSON.stringify({ file_path }), createToolContext());
		expect(JSON.stringify(await readWith(parent, visible))).toContain(
			"public fixture",
		);
		for (const file of [hidden, outside])
			await expect(readWith(parent, file)).rejects.toThrow(
				"outside_authority_ceiling",
			);
		const readParentLine = (file_path: string) =>
			parentLine.executeRaw(
				JSON.stringify({ file_path, line_number: 1 }),
				createToolContext(),
			);
		expect(JSON.stringify(await readParentLine(visible))).toContain(
			"public fixture",
		);
		await expect(readParentLine(hidden)).rejects.toThrow(
			"outside_read_authority",
		);
		await tree.spawn(
			{
				kind: "subagent",
				name: "Reader",
				prompt: "Read fixtures",
				workspace_access: "read-only",
			},
			{ session_id: "file-owner" },
		);
		if (!childChannel) throw new Error("missing child channel");
		const childTools = createSubagentReadTools(root, undefined, {
			channel: childChannel,
		});
		const call = (name: string, args: Record<string, unknown>) => {
			const tool = childTools.find((entry) => entry.name === name);
			if (!tool) throw new Error("missing child file tool");
			return tool.executeRaw(JSON.stringify(args), createToolContext());
		};
		expect(
			JSON.stringify(await call("read", { file_path: visible })),
		).toContain("public fixture");
		await expect(call("read", { file_path: hidden })).rejects.toThrow(
			"permission denied",
		);
		await expect(
			call("read_line", { file_path: hidden, line_number: 1 }),
		).rejects.toThrow("permission denied");
		await expect(call("read", { file_path: outside })).rejects.toThrow(
			"outside delegated workspace",
		);
		expect(JSON.stringify(await call("list_files", {}))).toContain(
			"visible.txt",
		);
		expect(JSON.stringify(await call("list_files", {}))).not.toContain(
			"hidden.txt",
		);
		const search = JSON.stringify(
			await call("search_files", { query: "matching" }),
		);
		expect(search).toContain("public fixture");
		expect(search).not.toContain("hidden");
		expect(search).not.toContain("unrelated");
		await fs.writeFile(visible, "\u0001".repeat(64 * 1024));
		const escapedPreview = await call("read", { file_path: visible });
		expect(Buffer.byteLength(JSON.stringify(escapedPreview))).toBeLessThan(
			240 * 1024,
		);
		expect(JSON.stringify(escapedPreview)).toContain("content_sha256");

		revokeOnSelection = true;
		await expect(call("list_files", {})).rejects.toThrow("permission expired");
		await expect(readWith(parent, visible)).rejects.toThrow(
			"outside_authority_ceiling",
		);
		await expect(readParentLine(visible)).rejects.toThrow(
			"outside_read_authority",
		);
		expect(JSON.stringify(await call("list_files", {}))).not.toContain(
			"visible.txt",
		);
		await expect(call("read", { file_path: visible })).rejects.toThrow(
			"permission denied",
		);
	} finally {
		await tasks.shutdown();
		await fs.rm(base, { recursive: true, force: true });
	}
});

test("replacing an approved destination ancestor blocks create and move before launch", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), "codelia-parent-binding-")),
	);
	try {
		const state = new RuntimeState();
		state.runtimeSandboxRoot = root;
		const parent = path.join(root, "approved");
		const original = path.join(root, "moved-aside");
		await fs.writeFile(path.join(root, "source.txt"), "before\n");
		await fs.mkdir(parent);
		let replaceOnPrompt = true;
		let confirmations = 0;
		let launches = 0;
		state.setRuntimeEnvironment({
			adapters: {
				approvalShellAuthority: {
					investigation: true,
					workspaceWrite: "confirm",
					stdinPipe: "forbid",
				},
				shellProtectionBackend: {
					...fixtureShellBackend,
					launch(invocation, protection) {
						launches++;
						return fixtureShellBackend.launch(invocation, protection);
					},
				},
				approvalService: {
					async confirm({ requestId }) {
						confirmations++;
						if (replaceOnPrompt) {
							await fs.rename(parent, original);
							await fs.mkdir(parent);
						}
						return { requestId, choice: "allow_once" };
					},
				},
			},
		});
		const sandboxKey = createSandboxKey(
			await SandboxContext.create(root, {
				protectResources: true,
				mutations: await runtimeFileMutations(state, root),
			}),
		);
		const approval = createRuntimeToolApproval({
			state,
			sandboxKey,
			builtinNames: new Set(["write", "apply_patch"]),
		});
		const write = approval.wrap(createWriteTool(sandboxKey), "builtin");
		const patch = approval.wrap(createApplyPatchTool(sandboxKey), "builtin");
		await expect(
			write.executeRaw(
				JSON.stringify({
					file_path: "approved/nested/new.txt",
					content: "create",
				}),
				createToolContext(),
			),
		).rejects.toThrow("approval_expired");
		await fs.rm(original, { recursive: true });
		const move = () =>
			patch.executeRaw(
				JSON.stringify({
					patch:
						"*** Begin Patch\n*** Update File: source.txt\n*** Move to: approved/nested/moved.txt\n@@\n-before\n+after\n*** End Patch",
				}),
				createToolContext(),
			);
		await expect(move()).rejects.toThrow("approval_expired");
		expect(await fs.readdir(parent)).toEqual([]);
		expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe(
			"before\n",
		);
		expect([confirmations, launches]).toEqual([2, 0]);

		replaceOnPrompt = false;
		await move();
		expect(
			await fs.readFile(path.join(parent, "nested/moved.txt"), "utf8"),
		).toBe("after\n");
		expect([confirmations, launches]).toEqual([3, 1]);
		await patch.executeRaw(
			JSON.stringify({
				patch:
					"*** Begin Patch\n*** Add File: new-parent/first.txt\n+first\n*** Add File: new-parent/second.txt\n+second\n*** End Patch",
			}),
			createToolContext(),
		);
		expect((await fs.readdir(path.join(root, "new-parent"))).sort()).toEqual([
			"first.txt",
			"second.txt",
		]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
