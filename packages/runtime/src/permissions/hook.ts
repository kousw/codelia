import type { PermissionRule } from "@codelia/config";
import type {
	AgentEvent,
	DependencyKey,
	Tool,
	ToolPermissionHook,
} from "@codelia/core";
import type {
	UiConfirmRequestParams,
	UiConfirmResult,
} from "@codelia/protocol";
import type { SandboxContext } from "../sandbox/context";
import type { PermissionService } from "./service";
import { buildPermissionPreview } from "./preview";

export type ToolPermissionHookCapabilities = {
	permissionService: PermissionService;
	hostToolNames: ReadonlySet<string>;
	isAutoApprovedTool: (tool: string) => boolean;
	supportsConfirm: () => boolean;
	getActiveRunId: () => string | undefined;
	requestConfirm: (
		params: UiConfirmRequestParams,
	) => Promise<UiConfirmResult | null>;
	emitAgentEvent: (runId: string, event: AgentEvent) => Promise<void>;
	sendAwaitingUiStatus: (runId: string) => Promise<void>;
	sendRunningStatus: (runId: string) => void;
	persistAllowRules: (rules: PermissionRule[]) => Promise<void>;
	debug: (message: string) => void;
	log: (message: string) => void;
	sandboxKey: DependencyKey<SandboxContext> | null;
	editTool?: Tool;
	applyPatchTool?: Tool;
};

export const createToolPermissionHook = ({
	permissionService,
	hostToolNames,
	isAutoApprovedTool,
	supportsConfirm,
	getActiveRunId,
	requestConfirm,
	emitAgentEvent,
	sendAwaitingUiStatus,
	sendRunningStatus,
	persistAllowRules,
	debug,
	log,
	sandboxKey,
	editTool,
	applyPatchTool,
}: ToolPermissionHookCapabilities): ToolPermissionHook => {
	return async (call, rawArgs, toolContext) => {
		const tool = call.function.name;
		if (hostToolNames.has(tool)) {
			debug(`permission.evaluate tool=${tool} decision=allow reason=host-tool`);
			return { decision: "allow" };
		}
		if (isAutoApprovedTool(tool)) {
			debug(
				`permission.evaluate tool=${tool} decision=allow reason=client-tool-auto-approved`,
			);
			return { decision: "allow" };
		}

		const decision = permissionService.evaluate(tool, rawArgs);
		debug(
			`permission.evaluate tool=${tool} decision=${decision.decision}${decision.reason ? ` reason=${decision.reason}` : ""}`,
		);
		if (decision.decision === "allow") {
			return { decision: "allow" };
		}
		if (decision.decision === "deny") {
			return { decision: "deny", reason: decision.reason };
		}
		if (!supportsConfirm()) {
			return {
				decision: "deny",
				reason: "UI confirm not supported",
			};
		}

		const runId = getActiveRunId();
		debug(`permission.request tool=${tool} args=${rawArgs}`);
		const prompt = permissionService.getConfirmPrompt(tool, rawArgs);
		const preview = await buildPermissionPreview({
			tool,
			rawArgs,
			toolContext,
			sandboxKey,
			...(editTool ? { editTool } : {}),
			...(applyPatchTool ? { applyPatchTool } : {}),
		});

		if (runId) {
			if (preview.diff || preview.summary) {
				await emitAgentEvent(runId, {
					type: "permission.preview",
					tool,
					tool_call_id: call.id,
					...(preview.filePath ? { file_path: preview.filePath } : {}),
					...(preview.language ? { language: preview.language } : {}),
					...(preview.diff ? { diff: preview.diff } : {}),
					...(preview.summary ? { summary: preview.summary } : {}),
					...(preview.truncated ? { truncated: true } : {}),
				});
			}
			await emitAgentEvent(runId, {
				type: "permission.ready",
				tool,
				tool_call_id: call.id,
			});
			await sendAwaitingUiStatus(runId);
		}

		const confirmResult = await requestConfirm({
			run_id: runId,
			title: prompt.title,
			message: prompt.message,
			confirm_label: "Allow",
			cancel_label: "Deny",
			allow_remember: true,
			allow_reason: true,
		});
		if (runId) {
			sendRunningStatus(runId);
		}
		if (!confirmResult?.ok) {
			const providedReason = confirmResult?.reason?.trim() ?? "";
			const reason = providedReason || "permission denied";
			const stopTurn = providedReason.length === 0;
			debug(
				`permission.confirm denied tool=${tool} stop_turn=${String(stopTurn)}${reason ? ` reason=${reason}` : ""}`,
			);
			return { decision: "deny", reason, stop_turn: stopTurn };
		}
		if (confirmResult.remember) {
			const rules = permissionService.rememberAllow(tool, rawArgs);
			debug(`permission.remember tool=${tool} rules=${rules.length}`);
			if (rules.length) {
				void persistAllowRules(rules).catch((error) => {
					log(`failed to persist permission: ${String(error)}`);
				});
			}
		}
		return { decision: "allow" };
	};
};
