export type UiPosition = {
	line: number;
	column: number;
};

export type UiRange = {
	start: UiPosition;
	end: UiPosition;
};

export type UiSelection = {
	path: string;
	range: UiRange;
	selected_text?: string;
};

export type UiContextUpdateParams = {
	cwd?: string;
	workspace_root?: string;
	active_file?: { path: string; language_id?: string };
	selection?: UiSelection;
	extensions?: Record<string, unknown>;
};

export type UiContextSnapshot = UiContextUpdateParams;
