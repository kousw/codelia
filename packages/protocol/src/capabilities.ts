import { wireInt } from "@codelia/shared-types";
import { z } from "zod";
import { AttachmentUploadLimitsSchema } from "./attachment";

const flag = () => z.boolean().optional();

export const UiCapabilitiesSchema = z
	.object({
		supports_goals: flag(),
		supports_confirm: flag(),
		supports_prompt: flag(),
		supports_pick: flag(),
		supports_structured_approval: flag(),
		/** Client drives sign-in via `auth.*`; runtime skips startup onboarding. */
		supports_auth_management: flag(),
		/** Opt-in to `run.context.usage` notifications after each model call. */
		supports_context_usage: flag(),
		/** Opt-in to `task.progress` notifications for subagent tasks. */
		supports_task_progress: flag(),
		supports_markdown: flag(),
		supports_images: flag(),
		supports_permission_preflight_events: flag(),
		/** Opt-in to provisional `text.delta` / `reasoning.delta` agent events. */
		supports_text_delta: flag(),
	})
	.meta({ id: "UiCapabilities" });
export type UiCapabilities = z.infer<typeof UiCapabilitiesSchema>;

export const ServerCapabilitiesSchema = z
	.object({
		supports_goals: flag(),
		/** model.fast accepts the explicit "ultrafast" selection. */
		supports_model_ultrafast: flag(),
		/** auth.logout accepts a provider without clearing other credentials. */
		supports_scoped_logout: flag(),
		/** auth.status/login/login.complete/login.cancel and auth.logout `confirmed`. */
		supports_auth_management: flag(),
		/** `session.open` binds the runtime to an existing session. */
		supports_session_open: flag(),
		supports_image_generation: flag(),
		supports_run_cancel: flag(),
		supports_run_steer: flag(),
		supports_attachment_upload: flag(),
		attachment_upload_limits: AttachmentUploadLimitsSchema.optional(),
		supports_run_diagnostics: flag(),
		supports_session_lifecycle: flag(),
		supports_shell_exec: flag(),
		supports_shell_tasks: flag(),
		supports_shell_detach: flag(),
		supports_tasks: flag(),
		supported_task_kinds: z.array(z.enum(["shell", "subagent"])).optional(),
		/** TaskSummary.progress and opt-in task.progress for subagent tasks. */
		supports_task_progress: flag(),
		max_subagent_depth: wireInt().optional(),
		supports_ui_requests: flag(),
		supports_structured_approval: flag(),
		supports_auto_review_configure: flag(),
		/** sandbox.get / sandbox.set for runtime sandbox policy. */
		supports_sandbox_mode_management: flag(),
		supports_mcp_list: flag(),
		supports_skills_list: flag(),
		supports_context_inspect: flag(),
		/** config.get/config.set over registry keys with value origins. */
		supports_config_rw: flag(),
		/** permissions.list/permissions.remove over config-file rules. */
		supports_permissions_rw: flag(),
		supports_project_allow_trust: flag(),
		/** context.usage request and opt-in run.context.usage notification. */
		supports_context_usage: flag(),
		supports_tool_call: flag(),
		supports_theme_set: flag(),
		supports_permission_preflight_events: flag(),
		/** Server emits `text.delta` / `reasoning.delta` to clients that opt in. */
		supports_text_delta: flag(),
	})
	.meta({ id: "ServerCapabilities" });
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
