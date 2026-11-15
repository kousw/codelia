export type UiCapabilities = {
	supports_confirm?: boolean;
	supports_prompt?: boolean;
	supports_pick?: boolean;
	/** Client drives sign-in via `auth.*`; runtime skips startup onboarding. */
	supports_auth_management?: boolean;
	supports_markdown?: boolean;
	supports_images?: boolean;
	supports_permission_preflight_events?: boolean;
};

export type ServerCapabilities = {
	/** model.fast accepts the explicit "ultrafast" selection. */
	supports_model_ultrafast?: boolean;
	/** auth.logout accepts a provider without clearing other credentials. */
	supports_scoped_logout?: boolean;
	/** auth.status/login/login.complete/login.cancel and auth.logout `confirmed`. */
	supports_auth_management?: boolean;
	supports_image_generation?: boolean;
	supports_run_cancel?: boolean;
	supports_run_diagnostics?: boolean;
	supports_shell_exec?: boolean;
	supports_shell_tasks?: boolean;
	supports_shell_detach?: boolean;
	supports_tasks?: boolean;
	supported_task_kinds?: Array<"shell" | "subagent">;
	max_subagent_depth?: number;
	supports_ui_requests?: boolean;
	supports_mcp_list?: boolean;
	supports_skills_list?: boolean;
	supports_context_inspect?: boolean;
	supports_tool_call?: boolean;
	supports_theme_set?: boolean;
	supports_permission_preflight_events?: boolean;
};
