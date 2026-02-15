import { TOP_LEVEL_HELP_TEXT, resolveTopLevelAction } from "./basic-options";
import { runMcpCommand } from "./commands/mcp";
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
		case "mcp": {
			const exitCode = await runMcpCommand(args.slice(1));
			process.exitCode = exitCode;
			return;
		}
		case "tui":
			runTui(args);
			return;
	}
};

void main();
