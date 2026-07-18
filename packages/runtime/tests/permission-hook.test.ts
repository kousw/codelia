import { describe, expect, test } from "bun:test";
import type {
	AgentEvent,
	Tool,
	ToolContext,
	ToolPermissionHook,
} from "@codelia/core";
import { createToolPermissionHook } from "../src/permissions/hook";
import {
	buildSystemPermissions,
	PermissionService,
} from "../src/permissions/service";

type ToolCall = Parameters<ToolPermissionHook>[0];

const call = (tool: string): ToolCall => ({
	id: "call-1",
	type: "function",
	function: { name: tool, arguments: "{}" },
});

const toolContext = {} as ToolContext;

const dryRunTool = (name: string, diff: string): Tool => ({
	name,
	description: name,
	definition: {
		type: "function",
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		strict: false,
	},
	executeRaw: async () => ({
		type: "json",
		value: { diff, summary: "preview" },
	}),
});

const createCapabilities = (
	overrides: Partial<Parameters<typeof createToolPermissionHook>[0]> = {},
) => ({
	permissionService: new PermissionService({
		approvalMode: "minimal",
		system: buildSystemPermissions("minimal"),
	}),
	hostToolNames: new Set<string>(),
	isAutoApprovedTool: () => false,
	supportsConfirm: () => true,
	getActiveRunId: () => "run-1",
	requestConfirm: async () => ({ ok: true }),
	emitAgentEvent: async () => {},
	sendAwaitingUiStatus: async () => {},
	sendRunningStatus: () => {},
	persistAllowRules: async () => {},
	debug: () => {},
	log: () => {},
	sandboxKey: null,
	...overrides,
});

describe("runtime tool permission hook", () => {
	test("allows host and auto-approved client tools without UI confirmation", async () => {
		let confirmCount = 0;
		const hook = createToolPermissionHook(
			createCapabilities({
				hostToolNames: new Set(["host_preview"]),
				isAutoApprovedTool: (tool) => tool === "client_progress",
				requestConfirm: async () => {
					confirmCount += 1;
					return { ok: true };
				},
			}),
		);

		expect(await hook(call("host_preview"), "{}", toolContext)).toEqual({
			decision: "allow",
		});
		expect(await hook(call("client_progress"), "{}", toolContext)).toEqual({
			decision: "allow",
		});
		expect(confirmCount).toBe(0);
	});

	test("preserves ready, awaiting, confirm, and running order", async () => {
		const order: string[] = [];
		const events: AgentEvent[] = [];
		const hook = createToolPermissionHook(
			createCapabilities({
				emitAgentEvent: async (_runId, event) => {
					events.push(event);
					order.push(event.type);
				},
				sendAwaitingUiStatus: async () => {
					order.push("awaiting_ui");
				},
				requestConfirm: async () => {
					order.push("confirm");
					return { ok: true };
				},
				sendRunningStatus: () => {
					order.push("running");
				},
			}),
		);

		expect(
			await hook(
				call("shell"),
				JSON.stringify({ command: "unknown-command" }),
				toolContext,
			),
		).toEqual({ decision: "allow" });
		expect(order).toEqual([
			"permission.ready",
			"awaiting_ui",
			"confirm",
			"running",
		]);
		expect(events[0]).toEqual(
			expect.objectContaining({
				type: "permission.ready",
				tool_call_id: "call-1",
			}),
		);
	});

	test("emits apply_patch preview before ready and infers its language", async () => {
		const events: AgentEvent[] = [];
		const hook = createToolPermissionHook(
			createCapabilities({
				applyPatchTool: dryRunTool(
					"apply_patch",
					"--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new",
				),
				emitAgentEvent: async (_runId, event) => {
					events.push(event);
				},
			}),
		);

		expect(
			await hook(
				call("apply_patch"),
				JSON.stringify({ patch: "patch" }),
				toolContext,
			),
		).toEqual({ decision: "allow" });
		expect(events.map((event) => event.type)).toEqual([
			"permission.preview",
			"permission.ready",
		]);
		expect(events[0]).toEqual(
			expect.objectContaining({
				type: "permission.preview",
				language: "ts",
			}),
		);
	});

	test("denial without a reason stops the turn", async () => {
		const hook = createToolPermissionHook(
			createCapabilities({ requestConfirm: async () => ({ ok: false }) }),
		);

		expect(
			await hook(
				call("shell"),
				JSON.stringify({ command: "unknown-command" }),
				toolContext,
			),
		).toEqual({
			decision: "deny",
			reason: "permission denied",
			stop_turn: true,
		});
	});
});
