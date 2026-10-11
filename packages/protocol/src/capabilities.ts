export type UiCapabilities = {
	supports_confirm?: boolean;
	supports_prompt?: boolean;
	supports_pick?: boolean;
	supports_markdown?: boolean;
	supports_images?: boolean;
	supports_permission_preflight_events?: boolean;
	supports_ui_request_cancel?: boolean;
	supports_text_stream?: boolean;
};

export type ServerCapabilities = {
	supports_new_session?: boolean;
	supports_run_model?: boolean;
	supports_session_model_guard?: boolean;
	supports_workspace_identity?: boolean;
	supports_worktrees?: boolean;
	supports_run_cancel?: boolean;
	supports_run_diagnostics?: boolean;
	supports_shell_exec?: boolean;
	supports_shell_tasks?: boolean;
	supports_shell_detach?: boolean;
	supports_tasks?: boolean;
	supported_task_kinds?: Array<"shell" | "subagent">;
	max_subagent_depth?: number;
	supports_ui_requests?: boolean;
	supports_ui_request_cancel?: boolean;
	supports_text_stream?: boolean;
	supports_mcp_list?: boolean;
	supports_skills_list?: boolean;
	supports_context_inspect?: boolean;
	supports_tool_call?: boolean;
	supports_theme_set?: boolean;
	supports_permission_preflight_events?: boolean;
};
