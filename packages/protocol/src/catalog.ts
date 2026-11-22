// Method catalog: binds each JSON-RPC method to its direction, schemas and
// capability gate. tools/protocol-codegen reads it to emit the JSON Schema and
// the Rust types. Enforcement of gates stays in the runtime and clients.
// See dev-docs/specs/protocol-codegen.md section 4.
import { GoalSnapshotSchema } from "@codelia/shared-types";
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
	AuthLogoutParamsSchema,
	AuthLogoutResultSchema,
	AuthStatusParamsSchema,
	AuthStatusResultSchema,
} from "./auth";
import type { ServerCapabilities, UiCapabilities } from "./capabilities";
import {
	ClientToolCallRequestParamsSchema,
	ClientToolCallResultSchema,
	ClientToolCancelParamsSchema,
} from "./client-tools";
import {
	GoalContinueParamsSchema,
	GoalGetParamsSchema,
	GoalPauseParamsSchema,
	GoalSetParamsSchema,
	GoalTargetSchema,
} from "./goal";
import { InitializeParamsSchema, InitializeResultSchema } from "./initialize";
import {
	AgentEventNotifySchema,
	RunCancelParamsSchema,
	RunCancelResultSchema,
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
import { ThemeSetParamsSchema, ThemeSetResultSchema } from "./theme";

/** Side that sends the request or notification. */
export type ProtocolSide = "ui" | "runtime";

type RequestInput =
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
	  };

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
	"auth.logout": request({
		from: "ui",
		params: AuthLogoutParamsSchema,
		result: AuthLogoutResultSchema,
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
