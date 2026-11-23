// Method catalog: binds each JSON-RPC method to its direction, schemas and
// capability gate. tools/protocol-codegen reads it to emit the JSON Schema and
// the Rust types. Enforcement of gates stays in the runtime and clients.
// See dev-docs/specs/protocol-codegen.md section 4.
import { GoalOfferSchema, GoalSnapshotSchema } from "@codelia/shared-types";
import type { z } from "zod";
import {
	AttachmentUploadBeginParamsSchema,
	AttachmentUploadBeginResultSchema,
	AttachmentUploadCancelResultSchema,
	AttachmentUploadChunkParamsSchema,
	AttachmentUploadChunkResultSchema,
	AttachmentUploadFinishResultSchema,
	AttachmentUploadIdParamsSchema,
} from "./attachment";
import {
	AuthLoginCancelParamsSchema,
	AuthLoginCancelResultSchema,
	AuthLoginCompleteParamsSchema,
	AuthLoginCompleteResultSchema,
	AuthLoginParamsSchema,
	AuthLoginResultSchema,
	AuthLoginStatusNotifySchema,
	AuthLogoutParamsSchema,
	AuthLogoutResultSchema,
	AuthStatusParamsSchema,
	AuthStatusResultSchema,
	AuthStorageResolveConflictParamsSchema,
	AuthStorageResolveConflictResultSchema,
} from "./auth";
import type { ServerCapabilities, UiCapabilities } from "./capabilities";
import {
	ClientToolCallRequestParamsSchema,
	ClientToolCallResultSchema,
	ClientToolCancelParamsSchema,
} from "./client-tools";
import {
	ConfigGetParamsSchema,
	ConfigGetResultSchema,
	ConfigSetParamsSchema,
	ConfigSetResultSchema,
} from "./config";
import {
	ContextInspectParamsSchema,
	ContextInspectResultSchema,
	ContextUsageParamsSchema,
	ContextUsageResultSchema,
	RunContextUsageNotifySchema,
} from "./context";
import {
	GoalContinueParamsSchema,
	GoalGetParamsSchema,
	GoalPauseParamsSchema,
	GoalSetParamsSchema,
	GoalTargetSchema,
} from "./goal";
import {
	ImageArtifactGetParamsSchema,
	ImageArtifactGetResultSchema,
	ImageModelConfigureParamsSchema,
	ImageModelConfigureResultSchema,
	ImageModelGetParamsSchema,
	ImageModelStatusSchema,
} from "./image";
import { InitializeParamsSchema, InitializeResultSchema } from "./initialize";
import { McpListParamsSchema, McpListResultSchema } from "./mcp";
import {
	ModelListParamsSchema,
	ModelListResultSchema,
	ModelSetParamsSchema,
	ModelSetResultSchema,
} from "./model";
import {
	AutoReviewConfigureParamsSchema,
	AutoReviewStatusSchema,
	PermissionsListParamsSchema,
	PermissionsListResultSchema,
	PermissionsRemoveParamsSchema,
	PermissionsRemoveResultSchema,
	ProjectAllowTrustSetParamsSchema,
	ProjectAllowTrustSetResultSchema,
	SandboxGetParamsSchema,
	SandboxGetResultSchema,
	SandboxSetErrorDataSchema,
	SandboxSetParamsSchema,
} from "./permissions";
import { InvalidParamsErrorDataSchema, RPC_ERROR_CODE } from "./rpc";
import {
	AgentEventNotifySchema,
	RunCancelParamsSchema,
	RunCancelResultSchema,
	RunContextNotifySchema,
	RunDiagnosticsNotifySchema,
	RunMetricsNotifySchema,
	RunStartParamsSchema,
	RunStartResultSchema,
	RunStatusNotifySchema,
	RunSteerParamsSchema,
	RunSteerResultSchema,
} from "./run";
import {
	SessionHistoryParamsSchema,
	SessionHistoryResultSchema,
	SessionListParamsSchema,
	SessionListResultSchema,
	SessionOpenParamsSchema,
	SessionOpenResultSchema,
	SessionUpdateParamsSchema,
	SessionUpdateResultSchema,
} from "./session";
import {
	ShellDetachResultSchema,
	ShellExecParamsSchema,
	ShellExecResultSchema,
	ShellListParamsSchema,
	ShellListResultSchema,
	ShellOutputParamsSchema,
	ShellOutputResultSchema,
	ShellStartParamsSchema,
	ShellTaskIdParamsSchema,
	ShellTaskInfoSchema,
	ShellWaitParamsSchema,
	ShellWaitResultSchema,
} from "./shell";
import { SkillsListParamsSchema, SkillsListResultSchema } from "./skills";
import {
	TaskIdParamsSchema,
	TaskInfoSchema,
	TaskListParamsSchema,
	TaskListResultSchema,
	TaskResultResultSchema,
	TaskProgressNotifySchema,
	TaskSpawnParamsSchema,
} from "./task";
import { ThemeSetParamsSchema, ThemeSetResultSchema } from "./theme";
import { ToolCallParamsSchema, ToolCallResultSchema } from "./tool";
import { UiContextUpdateParamsSchema } from "./ui-context";
import {
	UiConfirmRequestParamsSchema,
	UiConfirmResultSchema,
	UiPickCancelledParamsSchema,
	UiPickRequestParamsSchema,
	UiPickResultSchema,
	UiPromptRequestParamsSchema,
	UiPromptResultSchema,
} from "./ui-requests";

/** Side that sends the request or notification. */
export type ProtocolSide = "ui" | "runtime";

type RequestInput = { errorData?: z.ZodType } & (
	| {
			from: "ui";
			params: z.ZodType;
			result: z.ZodType;
			/** Server capability the UI checks before sending. */
			capability?: keyof ServerCapabilities;
	  }
	| {
			from: "runtime";
			params: z.ZodType;
			result: z.ZodType;
			/** UI capability the runtime checks before sending. */
			uiCapability?: keyof UiCapabilities;
	  }
);

type NotificationInput = {
	from: ProtocolSide;
	params: z.ZodType;
	capability?: keyof ServerCapabilities;
	uiCapability?: keyof UiCapabilities;
};

export const request = <const S extends RequestInput>(spec: S) =>
	({ kind: "request", ...spec }) as const;

export const notification = <const S extends NotificationInput>(spec: S) =>
	({ kind: "notification", ...spec }) as const;

type MethodSpec =
	| ReturnType<typeof request<RequestInput>>
	| ReturnType<typeof notification<NotificationInput>>;

export const defineMethods = <const M extends Record<string, MethodSpec>>(
	methods: M,
) => methods;

/** Shared structured error data, by JSON-RPC error code. Data is optional. */
export const protocolErrorData = {
	[RPC_ERROR_CODE.INVALID_PARAMS]: InvalidParamsErrorDataSchema,
} as const;

export const protocolMethods = defineMethods({
	initialize: request({
		from: "ui",
		params: InitializeParamsSchema,
		result: InitializeResultSchema,
	}),
	"theme.set": request({
		from: "ui",
		params: ThemeSetParamsSchema,
		result: ThemeSetResultSchema,
		capability: "supports_theme_set",
	}),
	"goal.set": request({
		from: "ui",
		params: GoalSetParamsSchema,
		result: GoalSnapshotSchema,
		capability: "supports_goals",
	}),
	"run.start": request({
		from: "ui",
		params: RunStartParamsSchema,
		result: RunStartResultSchema,
	}),
	"run.cancel": request({
		from: "ui",
		params: RunCancelParamsSchema,
		result: RunCancelResultSchema,
		capability: "supports_run_cancel",
	}),
	"attachment.upload.begin": request({
		from: "ui",
		params: AttachmentUploadBeginParamsSchema,
		result: AttachmentUploadBeginResultSchema,
		capability: "supports_attachment_upload",
	}),
	"attachment.upload.chunk": request({
		from: "ui",
		params: AttachmentUploadChunkParamsSchema,
		result: AttachmentUploadChunkResultSchema,
		capability: "supports_attachment_upload",
	}),
	"attachment.upload.finish": request({
		from: "ui",
		params: AttachmentUploadIdParamsSchema,
		result: AttachmentUploadFinishResultSchema,
		capability: "supports_attachment_upload",
	}),
	"attachment.upload.cancel": request({
		from: "ui",
		params: AttachmentUploadIdParamsSchema,
		result: AttachmentUploadCancelResultSchema,
		capability: "supports_attachment_upload",
	}),
	"goal.get": request({
		from: "ui",
		params: GoalGetParamsSchema,
		result: GoalSnapshotSchema,
		capability: "supports_goals",
	}),
	"goal.pause": request({
		from: "ui",
		params: GoalPauseParamsSchema,
		result: GoalSnapshotSchema,
		capability: "supports_goals",
	}),
	"goal.resume": request({
		from: "ui",
		params: GoalTargetSchema,
		result: GoalSnapshotSchema,
		capability: "supports_goals",
	}),
	"goal.clear": request({
		from: "ui",
		params: GoalTargetSchema,
		result: GoalSnapshotSchema,
		capability: "supports_goals",
	}),
	"goal.continue": request({
		from: "ui",
		params: GoalContinueParamsSchema,
		result: RunStartResultSchema,
		capability: "supports_goals",
	}),
	"session.list": request({
		from: "ui",
		params: SessionListParamsSchema,
		result: SessionListResultSchema,
	}),
	"session.history": request({
		from: "ui",
		params: SessionHistoryParamsSchema,
		result: SessionHistoryResultSchema,
	}),
	"session.open": request({
		from: "ui",
		params: SessionOpenParamsSchema,
		result: SessionOpenResultSchema,
		capability: "supports_session_open",
	}),
	"session.update": request({
		from: "ui",
		params: SessionUpdateParamsSchema,
		result: SessionUpdateResultSchema,
		capability: "supports_session_lifecycle",
	}),
	"auth.status": request({
		from: "ui",
		params: AuthStatusParamsSchema,
		result: AuthStatusResultSchema,
		capability: "supports_auth_management",
	}),
	"auth.login": request({
		from: "ui",
		params: AuthLoginParamsSchema,
		result: AuthLoginResultSchema,
		capability: "supports_auth_management",
	}),
	"auth.login.complete": request({
		from: "ui",
		params: AuthLoginCompleteParamsSchema,
		result: AuthLoginCompleteResultSchema,
		capability: "supports_auth_management",
	}),
	"auth.login.cancel": request({
		from: "ui",
		params: AuthLoginCancelParamsSchema,
		result: AuthLoginCancelResultSchema,
		capability: "supports_auth_management",
	}),
	"auth.storage.resolve_conflict": request({
		from: "ui",
		params: AuthStorageResolveConflictParamsSchema,
		result: AuthStorageResolveConflictResultSchema,
		capability: "supports_auth_management",
	}),
	"auth.logout": request({
		from: "ui",
		params: AuthLogoutParamsSchema,
		result: AuthLogoutResultSchema,
	}),
	"config.get": request({
		from: "ui",
		params: ConfigGetParamsSchema,
		result: ConfigGetResultSchema,
		capability: "supports_config_rw",
	}),
	"config.set": request({
		from: "ui",
		params: ConfigSetParamsSchema,
		result: ConfigSetResultSchema,
		capability: "supports_config_rw",
	}),
	"permissions.list": request({
		from: "ui",
		params: PermissionsListParamsSchema,
		result: PermissionsListResultSchema,
		capability: "supports_permissions_rw",
	}),
	"permissions.remove": request({
		from: "ui",
		params: PermissionsRemoveParamsSchema,
		result: PermissionsRemoveResultSchema,
		capability: "supports_permissions_rw",
	}),
	"permissions.projectTrust.set": request({
		from: "ui",
		params: ProjectAllowTrustSetParamsSchema,
		result: ProjectAllowTrustSetResultSchema,
		capability: "supports_project_allow_trust",
	}),
	"sandbox.get": request({
		from: "ui",
		params: SandboxGetParamsSchema,
		result: SandboxGetResultSchema,
		capability: "supports_sandbox_mode_management",
	}),
	"sandbox.set": request({
		from: "ui",
		params: SandboxSetParamsSchema,
		errorData: SandboxSetErrorDataSchema,
		result: SandboxGetResultSchema,
		capability: "supports_sandbox_mode_management",
	}),
	"auto_review.configure": request({
		from: "ui",
		params: AutoReviewConfigureParamsSchema,
		result: AutoReviewStatusSchema,
		capability: "supports_auto_review_configure",
	}),
	"model.list": request({
		from: "ui",
		params: ModelListParamsSchema,
		result: ModelListResultSchema,
	}),
	"model.set": request({
		from: "ui",
		params: ModelSetParamsSchema,
		result: ModelSetResultSchema,
	}),
	"image.model.get": request({
		from: "ui",
		params: ImageModelGetParamsSchema,
		result: ImageModelStatusSchema,
		capability: "supports_image_generation",
	}),
	"image.model.configure": request({
		from: "ui",
		params: ImageModelConfigureParamsSchema,
		result: ImageModelConfigureResultSchema,
		capability: "supports_image_generation",
	}),
	"image.artifact.get": request({
		from: "ui",
		params: ImageArtifactGetParamsSchema,
		result: ImageArtifactGetResultSchema,
		capability: "supports_image_generation",
	}),
	"tool.call": request({
		from: "ui",
		params: ToolCallParamsSchema,
		result: ToolCallResultSchema,
		capability: "supports_tool_call",
	}),
	"shell.exec": request({
		from: "ui",
		params: ShellExecParamsSchema,
		result: ShellExecResultSchema,
		capability: "supports_shell_exec",
	}),
	"shell.start": request({
		from: "ui",
		params: ShellStartParamsSchema,
		result: ShellTaskInfoSchema,
		capability: "supports_shell_tasks",
	}),
	"shell.list": request({
		from: "ui",
		params: ShellListParamsSchema,
		result: ShellListResultSchema,
		capability: "supports_shell_tasks",
	}),
	"shell.status": request({
		from: "ui",
		params: ShellTaskIdParamsSchema,
		result: ShellTaskInfoSchema,
		capability: "supports_shell_tasks",
	}),
	"shell.output": request({
		from: "ui",
		params: ShellOutputParamsSchema,
		result: ShellOutputResultSchema,
		capability: "supports_shell_tasks",
	}),
	"shell.wait": request({
		from: "ui",
		params: ShellWaitParamsSchema,
		result: ShellWaitResultSchema,
		capability: "supports_shell_tasks",
	}),
	"shell.detach": request({
		from: "ui",
		params: ShellTaskIdParamsSchema,
		result: ShellDetachResultSchema,
		capability: "supports_shell_detach",
	}),
	"shell.cancel": request({
		from: "ui",
		params: ShellTaskIdParamsSchema,
		result: ShellTaskInfoSchema,
		capability: "supports_shell_tasks",
	}),
	"task.spawn": request({
		from: "ui",
		params: TaskSpawnParamsSchema,
		result: TaskInfoSchema,
		capability: "supports_tasks",
	}),
	"task.list": request({
		from: "ui",
		params: TaskListParamsSchema,
		result: TaskListResultSchema,
		capability: "supports_tasks",
	}),
	"task.status": request({
		from: "ui",
		params: TaskIdParamsSchema,
		result: TaskInfoSchema,
		capability: "supports_tasks",
	}),
	"task.wait": request({
		from: "ui",
		params: TaskIdParamsSchema,
		result: TaskInfoSchema,
		capability: "supports_tasks",
	}),
	"task.cancel": request({
		from: "ui",
		params: TaskIdParamsSchema,
		result: TaskInfoSchema,
		capability: "supports_tasks",
	}),
	"task.result": request({
		from: "ui",
		params: TaskIdParamsSchema,
		result: TaskResultResultSchema,
		capability: "supports_tasks",
	}),
	"mcp.list": request({
		from: "ui",
		params: McpListParamsSchema,
		result: McpListResultSchema,
		capability: "supports_mcp_list",
	}),
	"skills.list": request({
		from: "ui",
		params: SkillsListParamsSchema,
		result: SkillsListResultSchema,
		capability: "supports_skills_list",
	}),
	"context.inspect": request({
		from: "ui",
		params: ContextInspectParamsSchema,
		result: ContextInspectResultSchema,
		capability: "supports_context_inspect",
	}),
	"context.usage": request({
		from: "ui",
		params: ContextUsageParamsSchema,
		result: ContextUsageResultSchema,
		capability: "supports_context_usage",
	}),
	"ui.context.update": notification({
		from: "ui",
		params: UiContextUpdateParamsSchema,
	}),
	"run.steer": request({
		from: "ui",
		params: RunSteerParamsSchema,
		result: RunSteerResultSchema,
		capability: "supports_run_steer",
	}),
	"run.status": notification({
		from: "runtime",
		params: RunStatusNotifySchema,
	}),
	"run.metrics": notification({
		from: "runtime",
		params: RunMetricsNotifySchema,
	}),
	"agent.event": notification({
		from: "runtime",
		params: AgentEventNotifySchema,
	}),
	"run.context": notification({
		from: "runtime",
		params: RunContextNotifySchema,
	}),
	"run.diagnostics": notification({
		from: "runtime",
		params: RunDiagnosticsNotifySchema,
	}),
	"run.context.usage": notification({
		from: "runtime",
		params: RunContextUsageNotifySchema,
		uiCapability: "supports_context_usage",
	}),
	"goal.updated": notification({
		from: "runtime",
		params: GoalSnapshotSchema,
		uiCapability: "supports_goals",
	}),
	"goal.cleared": notification({
		from: "runtime",
		params: GoalSnapshotSchema,
		uiCapability: "supports_goals",
	}),
	"goal.ready": notification({
		from: "runtime",
		params: GoalOfferSchema,
		uiCapability: "supports_goals",
	}),
	"auth.login.status": notification({
		from: "runtime",
		params: AuthLoginStatusNotifySchema,
		uiCapability: "supports_auth_management",
	}),
	"task.progress": notification({
		from: "runtime",
		params: TaskProgressNotifySchema,
		uiCapability: "supports_task_progress",
	}),
	"ui.confirm.request": request({
		from: "runtime",
		params: UiConfirmRequestParamsSchema,
		result: UiConfirmResultSchema,
		uiCapability: "supports_confirm",
	}),
	"ui.prompt.request": request({
		from: "runtime",
		params: UiPromptRequestParamsSchema,
		result: UiPromptResultSchema,
		uiCapability: "supports_prompt",
	}),
	"ui.pick.request": request({
		from: "runtime",
		params: UiPickRequestParamsSchema,
		result: UiPickResultSchema,
		uiCapability: "supports_pick",
	}),
	"ui.pick.cancelled": notification({
		from: "runtime",
		params: UiPickCancelledParamsSchema,
		uiCapability: "supports_pick",
	}),
	"client.tool.call": request({
		from: "runtime",
		params: ClientToolCallRequestParamsSchema,
		result: ClientToolCallResultSchema,
	}),
	"client.tool.cancel": notification({
		from: "runtime",
		params: ClientToolCancelParamsSchema,
	}),
});

export type ProtocolMethods = typeof protocolMethods;
export type CatalogMethod = keyof ProtocolMethods;

/** Catalogued methods of one kind sent by one side. */
export type MethodsFrom<
	S extends ProtocolSide,
	K extends "request" | "notification" = "request" | "notification",
> = {
	[M in CatalogMethod]: ProtocolMethods[M] extends { from: S; kind: K }
		? M
		: never;
}[CatalogMethod];

export type RequestMethod = {
	[M in CatalogMethod]: ProtocolMethods[M] extends { kind: "request" }
		? M
		: never;
}[CatalogMethod];

export type ParamsOf<M extends CatalogMethod> = z.infer<
	ProtocolMethods[M]["params"]
>;

export type ResultOf<M extends RequestMethod> = ProtocolMethods[M] extends {
	result: infer R extends z.ZodType;
}
	? z.infer<R>
	: never;

export const isCatalogMethod = (method: string): method is CatalogMethod =>
	Object.hasOwn(protocolMethods, method);
