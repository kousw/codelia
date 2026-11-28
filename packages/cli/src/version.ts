declare const __CODELIA_CLI_VERSION__: string | undefined;
declare const __CODELIA_CLI_BUILD__: string | undefined;

export const CLI_VERSION =
	typeof __CODELIA_CLI_VERSION__ === "string" &&
	__CODELIA_CLI_VERSION__.trim().length > 0
		? __CODELIA_CLI_VERSION__
		: "0.0.0";

export const CLI_BUILD: string | undefined =
	typeof __CODELIA_CLI_BUILD__ === "string" &&
	__CODELIA_CLI_BUILD__.trim().length > 0
		? __CODELIA_CLI_BUILD__.trim()
		: undefined;

export const CLI_VERSION_DISPLAY = CLI_BUILD
	? `${CLI_VERSION} (dev ${CLI_BUILD})`
	: CLI_VERSION;
