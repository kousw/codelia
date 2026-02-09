import { runMcpCommand } from "./commands/mcp";
import { runTui } from "./tui/launcher";

const args = process.argv.slice(2);

const main = async (): Promise<void> => {
	if (args[0] === "mcp") {
		const exitCode = await runMcpCommand(args.slice(1));
		process.exitCode = exitCode;
		return;
	}
	runTui(args);
};

void main();
