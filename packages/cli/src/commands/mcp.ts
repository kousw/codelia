import { runMcpAuthCommand } from "./mcp-auth";
import { runMcpConfigCommand } from "./mcp-config";

export const runMcpCommand = async (values: string[]): Promise<number> => {
	const [subcommand, ...rest] = values;
	if (!subcommand) {
		console.error(
			"usage: codelia mcp <add|list|remove|enable|disable|test|auth> ...",
		);
		return 1;
	}

	if (subcommand === "auth") {
		return runMcpAuthCommand(rest);
	}

	const handled = await runMcpConfigCommand(subcommand, rest);
	if (handled >= 0) {
		return handled;
	}

	console.error(`unknown subcommand: ${subcommand}`);
	return 1;
};
