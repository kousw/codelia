export type UiCapabilities = {
	supports_confirm?: boolean;
	supports_prompt?: boolean;
	supports_pick?: boolean;
	supports_markdown?: boolean;
	supports_images?: boolean;
};

export type ServerCapabilities = {
	supports_run_cancel?: boolean;
	supports_ui_requests?: boolean;
	supports_mcp_list?: boolean;
	supports_skills_list?: boolean;
	supports_context_inspect?: boolean;
};
