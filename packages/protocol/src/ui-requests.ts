export type UiConfirmRequestParams = {
	run_id?: string;
	title: string;
	message: string;
	confirm_label?: string;
	cancel_label?: string;
	danger_level?: "normal" | "danger";
	allow_remember?: boolean;
	allow_reason?: boolean;
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
	/** Only set by a runtime that selects the structured approval path. */
	approval?: boolean;
	message?: string;
	run_id?: string;
	title: string;
	items: Array<{ id: string; label: string; detail?: string }>;
	multi?: boolean;
};

export type UiPickResult = {
	ids: string[];
};
