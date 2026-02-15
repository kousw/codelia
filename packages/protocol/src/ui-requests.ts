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
	run_id?: string;
	title: string;
	items: Array<{ id: string; label: string; detail?: string }>;
	multi?: boolean;
};

export type UiPickResult = {
	ids: string[];
};

export type UiClipboardReadRequestParams = {
	run_id?: string;
	purpose: "image_attachment" | "text_paste";
	formats: Array<"image/png" | "text/plain">;
	max_bytes?: number;
	prompt?: string;
};

export type UiClipboardReadResult = {
	ok: boolean;
	cancelled?: boolean;
	items?: Array<
		| {
				type: "image";
				media_type: "image/png";
				data_url: string;
				width?: number;
				height?: number;
				bytes: number;
		  }
		| {
				type: "text";
				text: string;
				bytes: number;
		  }
	>;
	error?: string;
};
