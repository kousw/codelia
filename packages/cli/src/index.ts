import {
	hasHarborShellApprovalFlag,
	resolvePromptModeApproval,
	resolvePromptModeSandbox,
	resolvePromptText,
	resolveTopLevelAction,
	TOP_LEVEL_HELP_TEXT,
	validatePromptText,
} from "./basic-options";
import { runAuthCommand } from "./commands/auth";
import { runMcpCommand } from "./commands/mcp";
import { runSessionCommand } from "./commands/session";
import { runPromptMode } from "./prompt-mode";
import { runTui } from "./tui/launcher";
import { CLI_VERSION } from "./version";

const args = process.argv.slice(2);

const main = async (): Promise<void> => {
	switch (resolveTopLevelAction(args)) {
		case "help":
			console.log(TOP_LEVEL_HELP_TEXT);
			return;
		case "version":
			console.log(CLI_VERSION);
			return;
		case "auth":
			process.exitCode = await runAuthCommand(args.slice(1));
			return;
		case "mcp": {
			const exitCode = await runMcpCommand(args.slice(1));
			process.exitCode = exitCode;
			return;
		}
		case "session": {
			process.exitCode = await runSessionCommand(args.slice(1));
			return;
		}
		case "prompt": {
			const prompt = validatePromptText(resolvePromptText(args));
			const sandboxMode = resolvePromptModeSandbox(args);
			const approvalMode = sandboxMode
				? undefined
				: resolvePromptModeApproval(args);
			const exitCode = await runPromptMode({
				prompt,
				approvalMode,
				sandboxMode,
				harborShellApproval: hasHarborShellApprovalFlag(args),
			});
			process.exitCode = exitCode;
			return;
		}
		case "tui":
			runTui(args);
			return;
	}
};

void main();
