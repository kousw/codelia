export const TOP_LEVEL_HELP_TEXT = [
	"usage: codelia [options] [-- <tui-options>]",
	"",
	"Top-level options:",
	"  -h, --help       Show this help",
	"  -V, -v, --version  Show codelia version",
	"  -p, --prompt <text>  Run one headless prompt and exit",
	"",
	"Commands:",
	"  auth authorize-keychain  Restore access to saved credentials after a macOS Keychain timeout or denial",
	"  mcp ...          Manage MCP servers and auth",
	"  session ...      List, pin, archive, or clean up session run logs",
	"  update [--check] Check for a newer release and install it",
	"",
	"Runtime options:",
	"  --sandbox-mode <readonly|workspace-write|full-access>",
	"  --approval-mode <minimal|trusted|full-access> (legacy)",
	"    trusted retains project allow rules. To disable OS isolation, use --sandbox-mode full-access.",
	"",
	"TUI options (passed through):",
	"  -r, --resume [session_id]",
	"  --debug[=true|false]",
	"  --diagnostics[=true|false]",
	"  --initial-message <text>",
	"  --initial-user-message <text>",
	"  --tui-mode <auto|inline|alternate>",
	"  --debug-perf[=true|false]",
	"  --sandbox-mode <readonly|workspace-write|full-access>",
	"",
	"In the TUI, use /auto-approve [status|off] to configure Auto approve.",
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

export type TopLevelAction =
	| "help"
	| "version"
	| "auth"
	| "mcp"
	| "session"
	| "update"
	| "prompt"
	| "tui";

export const resolveTopLevelAction = (args: string[]): TopLevelAction => {
	if (args[0] === "auth") return "auth";
	if (args[0] === "session") return "session";
	if (args[0] === "update") return "update";
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

const resolveRuntimeMode = (
	args: string[],
	flag: string,
	values: string,
): string | undefined => {
	for (let i = 0; i < args.length; i += 1) {
		const current = args[i];
		if (current === "--") {
			break;
		}
		if (current === "-p" || current === "--prompt") {
			i++;
			continue;
		}
		const value =
			current === flag
				? (args[i + 1] ?? "").trim()
				: current.startsWith(`${flag}=`)
					? current.slice(flag.length + 1).trim()
					: undefined;
		if (value === undefined) continue;
		if (!value) throw new Error(`${flag} requires a value (${values})`);
		if (!values.split("|").includes(value))
			throw new Error(`Invalid ${flag} (expected ${values})`);
		return value;
	}
	return undefined;
};

export const resolvePromptModeApproval = (args: string[]) =>
	resolveRuntimeMode(args, "--approval-mode", "minimal|trusted|full-access");

export const resolvePromptModeSandbox = (args: string[]) =>
	resolveRuntimeMode(
		args,
		"--sandbox-mode",
		"readonly|workspace-write|full-access",
	);

export const hasHarborShellApprovalFlag = (args: string[]): boolean => {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") break;
		if (["-p", "--prompt", "--sandbox-mode", "--approval-mode"].includes(arg)) {
			index++;
			continue;
		}
		if (arg === "--harbor-shell-approval") return true;
	}
	return false;
};

export const validatePromptText = (value: string | undefined): string => {
	const text = value?.trim() ?? "";
	if (text.length === 0) {
		throw new Error("Prompt is required after -p/--prompt");
	}
	return text;
};
