export const TOP_LEVEL_HELP_TEXT = [
	"usage: codelia [options] [-- <tui-options>]",
	"",
	"Top-level options:",
	"  -h, --help       Show this help",
	"  -V, -v, --version  Show codelia version",
	"  -p, --prompt <text>  Run one headless prompt and exit",
	"",
	"Commands:",
	"  mcp ...          Manage MCP servers and auth",
	"",
	"Runtime options:",
	"  --approval-mode <minimal|trusted|full-access>",
	"",
	"TUI options (passed through):",
	"  -r, --resume [session_id]",
	"  --debug[=true|false]",
	"  --diagnostics[=true|false]",
	"  --initial-message <text>",
	"  --initial-user-message <text>",
	"  --debug-perf[=true|false]",
	"  --approval-mode <minimal|trusted|full-access>",
].join("\n");

const isHelpFlag = (value: string): boolean =>
	value === "-h" || value === "--help" || value === "help";

const isVersionFlag = (value: string): boolean =>
	value === "-V" ||
	value === "-v" ||
	value === "--version" ||
	value === "version";

const hasPromptFlag = (args: string[]): boolean => {
	for (let i = 0; i < args.length; i += 1) {
		const current = args[i];
		if (current === "--") {
			break;
		}
		if (current === "-p" || current === "--prompt") {
			return true;
		}
		if (current.startsWith("--prompt=")) {
			return true;
		}
	}
	return false;
};

export type TopLevelAction = "help" | "version" | "mcp" | "prompt" | "tui";

export const resolveTopLevelAction = (args: string[]): TopLevelAction => {
	if (args[0] === "mcp") {
		return "mcp";
	}
	if (args.length === 1 && isHelpFlag(args[0])) {
		return "help";
	}
	if (args.length === 1 && isVersionFlag(args[0])) {
		return "version";
	}
	if (hasPromptFlag(args)) {
		return "prompt";
	}
	return "tui";
};

export const resolvePromptText = (args: string[]): string | undefined => {
	for (let i = 0; i < args.length; i += 1) {
		const current = args[i];
		if (current === "-p" || current === "--prompt") {
			const next = args[i + 1];
			if (!next) return undefined;
			return next;
		}
		if (current.startsWith("--prompt=")) {
			return current.slice("--prompt=".length);
		}
	}
	return undefined;
};

export const resolvePromptOptionValue = (
	args: string[],
	optionName: string,
): string | undefined => {
	for (let i = 0; i < args.length; i += 1) {
		const current = args[i];
		if (current === optionName) {
			return args[i + 1];
		}
		if (current.startsWith(`${optionName}=`)) {
			return current.slice(`${optionName}=`.length);
		}
	}
	return undefined;
};

export const resolvePromptModeApproval = (
	args: string[],
): string | undefined => {
	for (let i = 0; i < args.length; i += 1) {
		const current = args[i];
		if (current === "--") {
			break;
		}
		if (current === "--approval-mode") {
			const next = args[i + 1];
			if (!next || next.trim().length === 0) {
				throw new Error(
					"--approval-mode requires a value (minimal|trusted|full-access)",
				);
			}
			return next.trim();
		}
		if (current.startsWith("--approval-mode=")) {
			const value = current.slice("--approval-mode=".length).trim();
			if (value.length === 0) {
				throw new Error(
					"--approval-mode requires a value (minimal|trusted|full-access)",
				);
			}
			return value;
		}
	}
	return undefined;
};

export const validatePromptText = (value: string | undefined): string => {
	const text = value?.trim() ?? "";
	if (text.length === 0) {
		throw new Error("Prompt is required after -p/--prompt");
	}
	return text;
};
