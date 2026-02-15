declare const __CODELIA_CLI_VERSION__: string | undefined;

export const CLI_VERSION =
	typeof __CODELIA_CLI_VERSION__ === "string" &&
	__CODELIA_CLI_VERSION__.trim().length > 0
		? __CODELIA_CLI_VERSION__
		: "0.0.0";
