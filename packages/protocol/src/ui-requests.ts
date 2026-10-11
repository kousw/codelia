export type UiConfirmRequestParams = {
	run_id?: string;
	/** Exact child task origin; omitted for root/startup confirmations. */
	task_id?: string;
	title: string;
	message: string;
	confirm_label?: string;
	cancel_label?: string;
	danger_level?: "normal" | "danger";
	allow_remember?: boolean;
	allow_reason?: boolean;
	/** Exact worktree create scope; render paths as literal text, never Markdown. */
	worktree?: {
		actor: "user" | "parent_agent";
		operation_id: string;
		thread_id: string;
		source_path: string;
		base_commit: string;
		branch: string;
		path: string;
	};
};

export type UiConfirmResult = {
	ok: boolean;
	remember?: boolean;
	reason?: string;
};

export type UiPromptRequestParams = {
	run_id?: string;
	title: string;
	message: string;
	default_value?: string;
	multiline?: boolean;
	secret?: boolean;
};

export type UiPromptResult = {
	value: string | null;
};

export type UiPickRequestParams = {
	run_id?: string;
	title: string;
	items: Array<{ id: string; label: string; detail?: string }>;
	multi?: boolean;
};

export type UiPickResult = {
	ids: string[];
};

/** Sent only to clients that opt in to supports_ui_request_cancel. */
export type UiRequestCancelParams = {
	request_id: string;
	reason: "aborted";
};
