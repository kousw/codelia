import {
	hasHarborShellApprovalFlag,
	resolvePromptModeSandbox,
	resolvePromptText,
	resolveTopLevelAction,
	TOP_LEVEL_HELP_TEXT,
	validatePromptText,
} from "./basic-options";
import { resolveLoadedCliPackageRoot } from "./package-root";
import { CLI_VERSION } from "./version";

const args = process.argv.slice(2);
const packageRoot = resolveLoadedCliPackageRoot();

const main = async (): Promise<void> => {
	switch (resolveTopLevelAction(args)) {
		case "help":
			console.log(TOP_LEVEL_HELP_TEXT);
			return;
		case "version":
			console.log(CLI_VERSION);
			return;
		case "auth": {
			const { runAuthCommand } = await import("./commands/auth");
			process.exitCode = await runAuthCommand(args.slice(1));
			return;
		}
		case "mcp": {
			const { runMcpCommand } = await import("./commands/mcp");
			process.exitCode = await runMcpCommand(args.slice(1));
			return;
		}
		case "session": {
			const { runSessionCommand } = await import("./commands/session");
			process.exitCode = await runSessionCommand(args.slice(1));
			return;
		}
		case "update": {
			const { runUpdateCommand } = await import("./commands/update");
			process.exitCode = await runUpdateCommand(args.slice(1), { packageRoot });
			return;
		}
		case "prompt": {
			const prompt = validatePromptText(resolvePromptText(args));
			const sandboxMode = resolvePromptModeSandbox(args);
			const { runPromptMode } = await import("./prompt-mode");
			process.exitCode = await runPromptMode({
				prompt,
				sandboxMode,
				harborShellApproval: hasHarborShellApprovalFlag(args),
			});
			return;
		}
		case "tui": {
			const { prepareTuiLaunch } = await import("./update/launch");
			const prepared = await prepareTuiLaunch({
				args,
				currentVersion: CLI_VERSION,
				packageRoot,
			});
			if (prepared.kind === "exit") {
				process.exitCode = prepared.exitCode;
				return;
			}
			try {
				const { runTui } = await import("./tui/launcher");
				runTui(args, prepared.session, packageRoot);
			} catch (error) {
				prepared.session.dispose();
				throw error;
			}
			return;
		}
	}
};

void main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
