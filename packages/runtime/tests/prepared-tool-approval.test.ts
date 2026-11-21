import { expect, spyOn, test } from "bun:test";
import {
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineTool, type ToolContext } from "@codelia/core";
import { z } from "zod";
import { createRuntimeToolApproval } from "../src/permissions/tool-approval";
import { RuntimeState } from "../src/runtime-state";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createApplyPatchTool } from "../src/tools/apply-patch";
import { createClientToolAdapters } from "../src/tools/client";

test("user tool allows match local registrations and expire when removed from config", async () => {
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), "codelia-tool-allows-")),
	);
	const workspace = path.join(root, "workspace");
	const config = path.join(root, "config.json");
	const original = process.env.CODELIA_CONFIG_PATH;
	const writeConfig = (tools: string[]) =>
		writeFile(
			config,
			JSON.stringify({
				version: 1,
				permissions: { allow: tools.map((tool) => ({ tool })) },
			}),
			{ mode: 0o600 },
		);
	let prompts = 0;
	let executions = 0;
	const state = new RuntimeState();
	const context: ToolContext = {
		deps: {},
		resolve: async (key) => key.create(),
	};
	const builtin = (name: string) =>
		defineTool({
			name,
			description: "Fixture for a locally registered tool",
			input: z.object({}),
			execute: () => ++executions,
		});
	try {
		await mkdir(workspace);
		process.env.CODELIA_CONFIG_PATH = config;
		await writeConfig(["webfetch", "search", "task_spawn", "task_cancel_all"]);
		state.runtimeSandboxRoot = workspace;
		state.setRuntimeEnvironment({
			adapters: {
				approvalService: {
					confirm: async ({ requestId }) => {
						prompts++;
						return { requestId, choice: "deny_continue" };
					},
				},
			},
		});
		const options = {
			state,
			builtinNames: new Set([
				"webfetch",
				"search",
				"task_spawn",
				"task_cancel_all",
			]),
		};
		const admission = createRuntimeToolApproval(options);
		const webfetch = builtin("webfetch");
		const registered = admission.wrap(webfetch, "builtin");
		await registered.executeRaw("{}", context);
		await admission
			.wrap(builtin("search"), "builtin")
			.executeRaw("{}", context);
		await admission
			.wrap(builtin("task_cancel_all"), "builtin")
			.executeRaw("{}", context);
		expect([executions, prompts]).toEqual([3, 0]);
		await expect(
			admission.wrap(webfetch, "host").executeRaw("{}", context),
		).rejects.toThrow("user_denied");
		await expect(
			admission
				.wrap(builtin("task_spawn"), "builtin")
				.executeRaw("{}", context),
		).rejects.toThrow("user_denied");
		const denied = createRuntimeToolApproval({
			...options,
			deny: [{ tool: "webfetch" }],
		});
		await expect(
			denied.wrap(webfetch, "builtin").executeRaw("{}", context),
		).rejects.toThrow("legacy_deny_rule");
		await mkdir(path.join(workspace, ".codelia"));
		await writeFile(
			path.join(workspace, ".codelia", "config.json"),
			JSON.stringify({
				version: 1,
				permissions: { deny: [{ tool: "search" }] },
			}),
		);
		await expect(
			admission.wrap(builtin("search"), "builtin").executeRaw("{}", context),
		).rejects.toThrow("legacy_deny_rule");
		await writeConfig([]);
		await expect(registered.executeRaw("{}", context)).rejects.toThrow(
			"user_denied",
		);
		expect([executions, prompts]).toEqual([3, 3]);
	} finally {
		if (original === undefined) delete process.env.CODELIA_CONFIG_PATH;
		else process.env.CODELIA_CONFIG_PATH = original;
		await rm(root, { recursive: true, force: true });
	}
});

test("tool admission classifies the same once-normalized input that executes", async () => {
	const state = new RuntimeState();
	const target = "fixture-destination";
	let validations = 0;
	let executions = 0;
	let prompts = 0;
	state.setRuntimeEnvironment({
		adapters: {
			approvalToolEffect: (_registration, args) => ({
				kind: "external_update",
				resources: [{ operation: "network", target: String(args.target) }],
			}),
			approvalToolAuthority: (registration) => {
				const resources = [
					{ operation: "invoke", target: registration.name },
					{ operation: "network", target },
				] as const;
				return { ceiling: resources, granted: resources };
			},
			approvalService: {
				confirm: async (request) => {
					prompts++;
					expect(request.route.reason).toBe("external_mutation");
					expect(request.route.resources).toContainEqual({
						operation: "network",
						target,
					});
					expect(request.preview).not.toContain("note");
					expect([validations, executions]).toEqual([1, 0]);
					return { requestId: request.requestId, choice: "allow_once" };
				},
			},
		},
	});
	const tool = defineTool({
		name: "fixture_update",
		description: "Record a normalized target in the fixture",
		input: z
			.object({
				target: z.string().overwrite((value) => {
					validations++;
					return value.trim();
				}),
			})
			.transform((input) => ({ ...input, note: undefined })),
		execute: (input) => {
			executions++;
			expect(input.note).toBeUndefined();
			return { target: input.target };
		},
	});
	const managed = createRuntimeToolApproval({
		state,
		builtinNames: new Set(),
	}).wrap(tool, "host");
	const context: ToolContext = {
		deps: {},
		resolve: async (key) => key.create(),
	};
	expect(
		await managed.executeRaw(
			JSON.stringify({ target: ` ${target} ` }),
			context,
		),
	).toEqual({ type: "json", value: { target } });
	expect([validations, prompts, executions]).toEqual([1, 1, 1]);
});

test("non-JSON normalized input cannot authorize or execute a tool under a lossy payload", async () => {
	const state = new RuntimeState();
	let effects = 0;
	let executions = 0;
	state.setRuntimeEnvironment({
		adapters: {
			approvalToolEffect: () => {
				effects++;
				return undefined;
			},
		},
	});
	const tool = defineTool({
		name: "non_json_update",
		description: "Test a transform to a non-JSON target",
		input: z.object({ target: z.string() }).transform(({ target }) => ({
			target: new Date(target),
		})),
		execute: () => {
			executions++;
			return "unexpected execution";
		},
	});
	const managed = createRuntimeToolApproval({
		state,
		builtinNames: new Set(),
	}).wrap(tool, "host");
	const context: ToolContext = {
		deps: {},
		resolve: async (key) => key.create(),
	};
	await expect(
		managed.executeRaw('{"target":"2026-11-19"}', context),
	).rejects.toThrow("invalid_arguments");
	expect([effects, executions]).toEqual([0, 0]);
});

test("builtin patch checks every target before its first write and keeps host policy authoritative", async () => {
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), "codelia-patch-approval-")),
	);
	const first = path.join(root, "first.txt");
	const second = path.join(root, "second.txt");
	const state = new RuntimeState();
	let prompts = 0;
	const confirmation = {
		confirm: async ({ requestId }: { requestId: string }) => {
			prompts++;
			return { requestId, choice: "deny_continue" as const };
		},
	};
	const request = JSON.stringify({
		patch:
			"*** Begin Patch\n*** Update File: first.txt\n@@\n-before\n+patched\n*** Update File: second.txt\n@@\n-before\n+patched\n*** End Patch",
	});
	const context: ToolContext = {
		deps: {},
		resolve: async (key) => key.create(),
	};
	const run = (
		current: RuntimeState,
		sandbox: SandboxContext,
		denyPatch = false,
	) => {
		current.runtimeSandboxRoot = root;
		const sandboxKey = createSandboxKey(sandbox);
		return createRuntimeToolApproval({
			state: current,
			builtinNames: new Set(["apply_patch"]),
			sandboxKey,
			...(denyPatch ? { deny: [{ tool: "apply_patch" }] } : {}),
		})
			.wrap(createApplyPatchTool(sandboxKey), "builtin")
			.executeRaw(request, context);
	};
	try {
		await Promise.all([
			writeFile(first, "before\n"),
			writeFile(second, "before\n"),
		]);
		const sandbox = await SandboxContext.create(root, {
			protectResources: true,
		});
		state.setRuntimeEnvironment({
			adapters: { approvalService: confirmation },
		});
		await expect(run(state, sandbox, true)).rejects.toThrow("legacy_deny_rule");
		const host = new RuntimeState();
		host.setRuntimeEnvironment({
			adapters: {
				approvalService: confirmation,
				approvalToolAuthority: () => {
					const resources = [
						{ operation: "invoke", target: "apply_patch" },
						{ operation: "write", target: first },
					] as const;
					return { ceiling: resources, granted: resources };
				},
			},
		});
		await expect(run(host, sandbox)).rejects.toThrow(
			"outside_authority_ceiling",
		);
		expect(await readFile(first, "utf8")).toBe("before\n");
		expect(await readFile(second, "utf8")).toBe("before\n");

		const readSelectedFile = SandboxContext.prototype.readSelectedFile;
		const lateChange = spyOn(
			SandboxContext.prototype,
			"readSelectedFile",
		).mockImplementation(async function (
			this: SandboxContext,
			operand,
			access,
		) {
			const content = await readSelectedFile.call(this, operand, access);
			if (operand === "second.txt")
				await writeFile(second, "changed by another editor\n");
			return content;
		});
		try {
			await expect(run(state, sandbox)).rejects.toThrow("approval_expired");
		} finally {
			lateChange.mockRestore();
		}
		expect(await readFile(first, "utf8")).toBe("before\n");
		expect(await readFile(second, "utf8")).toBe("changed by another editor\n");
		expect(prompts).toBe(0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("protected patch previews are read-only and an unsupported replacement fails before deletion", async () => {
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), "codelia-patch-preview-")),
	);
	try {
		await writeFile(path.join(root, "first.txt"), "first\n");
		await writeFile(path.join(root, "second.txt"), "second\n");
		const patch =
			"*** Begin Patch\n*** Delete File: first.txt\n*** Update File: second.txt\n*** Move to: first.txt\n@@\n-second\n+replacement\n*** End Patch";
		const run = async (
			sandboxMode: "readonly" | "workspace-write",
			body: string,
			dry_run: boolean,
		) => {
			const state = new RuntimeState();
			state.sandboxMode = { value: sandboxMode, source: "default" };
			state.runtimeSandboxRoot = root;
			state.setRuntimeEnvironment({
				adapters: {
					approvalService: {
						confirm: async ({ requestId }) => ({
							requestId,
							choice: "allow_once",
						}),
					},
				},
			});
			const sandbox = await SandboxContext.create(root, {
				sandboxMode,
				protectResources: true,
				...(dry_run
					? {}
					: {
							mutations: {
								supports: () => true,
								run: async () => {
									throw new Error("Unexpected mutation");
								},
							},
						}),
			});
			const sandboxKey = createSandboxKey(sandbox);
			return createRuntimeToolApproval({
				state,
				builtinNames: new Set(["apply_patch"]),
				sandboxKey,
			})
				.wrap(createApplyPatchTool(sandboxKey), "builtin")
				.executeRaw(JSON.stringify({ patch: body, dry_run }), {
					deps: {},
					resolve: async (key) => key.create(),
				});
		};
		await expect(run("readonly", patch, true)).resolves.toMatchObject({
			type: "json",
			value: { file_count: 2 },
		});
		await expect(
			run(
				"workspace-write",
				"*** Begin Patch\n*** Add File: new.txt\n+new\n*** End Patch",
				true,
			),
		).resolves.toMatchObject({ type: "json", value: { file_count: 1 } });
		await expect(run("workspace-write", patch, false)).rejects.toThrow(
			"multiple changes to the same file",
		);
		if (process.platform !== "win32") {
			await symlink("first.txt", path.join(root, "symbolic.txt"));
			await expect(
				run(
					"workspace-write",
					"*** Begin Patch\n*** Delete File: symbolic.txt\n*** End Patch",
					false,
				),
			).rejects.toThrow("regular directory entry");
			await expect(
				run(
					"workspace-write",
					"*** Begin Patch\n*** Update File: symbolic.txt\n*** Move to: moved.txt\n*** End Patch",
					false,
				),
			).rejects.toThrow("regular directory entry");
			expect(
				(await lstat(path.join(root, "symbolic.txt"))).isSymbolicLink(),
			).toBe(true);
			await link(path.join(root, "first.txt"), path.join(root, "shared.txt"));
			await expect(
				run(
					"workspace-write",
					"*** Begin Patch\n*** Update File: first.txt\n@@\n-first\n+changed\n*** Delete File: shared.txt\n*** End Patch",
					false,
				),
			).rejects.toThrow("multiple changes to the same file");
			expect(await readFile(path.join(root, "shared.txt"), "utf8")).toBe(
				"first\n",
			);
		}
		expect(await readFile(path.join(root, "first.txt"), "utf8")).toBe(
			"first\n",
		);
		expect(await readFile(path.join(root, "second.txt"), "utf8")).toBe(
			"second\n",
		);
		expect(await Bun.file(path.join(root, "new.txt")).exists()).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("native TUI helper registration skips approval while generic client hints do not", async () => {
	const state = new RuntimeState();
	const runId = "fixture";
	state.beginRun(runId);
	state.lastClientInfo = { name: "codelia-tui", version: "fixture" };
	const originalParent = process.env.CODELIA_NATIVE_TUI_PARENT_PID;
	const originalWrite = process.stdout.write;
	const messages: unknown[] = [];
	try {
		const approval = createRuntimeToolApproval({
			state,
			builtinNames: new Set(),
		});
		const definition = {
			name: "tui_show_progress",
			description: "Fixture progress display",
			parameters: { type: "object" },
			approval: "never" as const,
		};
		const adapt = (name = definition.name) =>
			approval.wrap(
				createClientToolAdapters({
					runId,
					state,
					existingTools: [],
					tools: [{ ...definition, name }],
				})[0],
				"client",
			);
		const context: ToolContext = {
			deps: {},
			resolve: async (key) => key.create(),
		};
		delete process.env.CODELIA_NATIVE_TUI_PARENT_PID;
		await expect(adapt().executeRaw("{}", context)).rejects.toThrow(
			"confirmation_required",
		);
		process.env.CODELIA_NATIVE_TUI_PARENT_PID = String(process.ppid);
		await expect(
			adapt("arbitrary_progress").executeRaw("{}", context),
		).rejects.toThrow("confirmation_required");
		const wait = spyOn(state, "waitForUiResponse").mockResolvedValue({
			ok: true,
			result: "shown",
		});
		process.stdout.write = ((chunk: string | Uint8Array) => {
			messages.push(JSON.parse(String(chunk)));
			return true;
		}) as typeof process.stdout.write;
		try {
			await expect(adapt().executeRaw("{}", context)).resolves.toEqual({
				type: "text",
				text: "shown",
			});
			expect(messages).toMatchObject([
				{
					method: "client.tool.call",
					params: { run_id: runId, name: "tui_show_progress" },
				},
			]);
		} finally {
			wait.mockRestore();
		}
	} finally {
		process.stdout.write = originalWrite;
		if (originalParent === undefined)
			delete process.env.CODELIA_NATIVE_TUI_PARENT_PID;
		else process.env.CODELIA_NATIVE_TUI_PARENT_PID = originalParent;
	}
});
