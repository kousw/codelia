export type UiCapabilities = {
	supports_confirm?: boolean;
	supports_prompt?: boolean;
	supports_pick?: boolean;
	/** Client drives sign-in via `auth.*`; runtime skips startup onboarding. */
	supports_auth_management?: boolean;
	/** Opt-in to `run.context.usage` notifications after each model call. */
	supports_context_usage?: boolean;
	/** Opt-in to `task.progress` notifications for subagent tasks. */
	supports_task_progress?: boolean;
	supports_markdown?: boolean;
	supports_images?: boolean;
	supports_permission_preflight_events?: boolean;
	/** Opt-in to provisional `text.delta` / `reasoning.delta` agent events. */
	supports_text_delta?: boolean;
};

export type ServerCapabilities = {
	/** model.fast accepts the explicit "ultrafast" selection. */
	supports_model_ultrafast?: boolean;
	/** auth.logout accepts a provider without clearing other credentials. */
	supports_scoped_logout?: boolean;
	/** auth.status/login/login.complete/login.cancel and auth.logout `confirmed`. */
	supports_auth_management?: boolean;
	/** `session.open` binds the runtime to an existing session. */
	supports_session_open?: boolean;
	supports_image_generation?: boolean;
	supports_run_cancel?: boolean;
	supports_run_steer?: boolean;
	supports_run_diagnostics?: boolean;
	supports_session_lifecycle?: boolean;
	supports_shell_exec?: boolean;
	supports_shell_tasks?: boolean;
	supports_shell_detach?: boolean;
	supports_tasks?: boolean;
	supported_task_kinds?: Array<"shell" | "subagent">;
	/** TaskSummary.progress and opt-in task.progress for subagent tasks. */
	supports_task_progress?: boolean;
	max_subagent_depth?: number;
	supports_ui_requests?: boolean;
	supports_mcp_list?: boolean;
	supports_skills_list?: boolean;
	supports_context_inspect?: boolean;
	/** config.get/config.set over registry keys with value origins. */
	supports_config_rw?: boolean;
	/** permissions.list/permissions.remove over config-file rules. */
	supports_permissions_rw?: boolean;
	/** context.usage request and opt-in run.context.usage notification. */
	supports_context_usage?: boolean;
	supports_tool_call?: boolean;
	supports_theme_set?: boolean;
	supports_permission_preflight_events?: boolean;
	/** Server emits `text.delta` / `reasoning.delta` to clients that opt in. */
	supports_text_delta?: boolean;
};
