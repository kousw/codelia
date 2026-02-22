export const TOP_LEVEL_HELP_TEXT = [
	"usage: codelia [options] [-- <tui-options>]",
	"",
	"Top-level options:",
	"  -h, --help       Show this help",
	"  -V, -v, --version  Show codelia version",
	"",
	"Commands:",
	"  mcp ...          Manage MCP servers and auth",
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

export type TopLevelAction = "help" | "version" | "mcp" | "tui";

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
	return "tui";
};
