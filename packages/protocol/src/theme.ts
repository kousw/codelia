export type ThemeSetParams = {
	name: string;
};

export type ThemeSetResult = {
	name: string;
	scope?: "global" | "project";
	path?: string;
};
