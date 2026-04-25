export type SlashCommandSpec = {
	command: string;
	insertText: string;
	usage: string;
	summary: string;
};

export const SLASH_COMMANDS: SlashCommandSpec[] = [
	{
		command: "/help",
		insertText: "/help",
		usage: "/help",
		summary: "Show desktop command help",
	},
	{
		command: "/new",
		insertText: "/new",
		usage: "/new",
		summary: "Start a new draft chat",
	},
	{
		command: "/compact",
		insertText: "/compact",
		usage: "/compact",
		summary: "Run forced context compaction",
	},
	{
		command: "/inspect",
		insertText: "/inspect",
		usage: "/inspect",
		summary: "Open the inspect rail",
	},
	{
		command: "/context",
		insertText: "/context ",
		usage: "/context [brief]",
		summary: "Open context in the inspect rail",
	},
	{
		command: "/skills",
		insertText: "/skills ",
		usage: "/skills",
		summary: "Open skills in the inspect rail",
	},
	{
		command: "/mcp",
		insertText: "/mcp",
		usage: "/mcp",
		summary: "Open MCP status in the inspect rail",
	},
	{
		command: "/model",
		insertText: "/model ",
		usage: "/model [provider/]name",
		summary: "Set the active model",
	},
	{
		command: "/reasoning",
		insertText: "/reasoning ",
		usage: "/reasoning <low|medium|high|xhigh>",
		summary: "Set reasoning effort",
	},
	{
		command: "/fast",
		insertText: "/fast ",
		usage: "/fast [on|off|toggle]",
		summary: "Toggle fast mode",
	},
];

export const slashCommandMatches = (input: string): SlashCommandSpec[] => {
	const trimmedStart = input.trimStart();
	if (!trimmedStart.startsWith("/")) {
		return [];
	}
	const token = trimmedStart.split(/\s+/, 1)[0] ?? "";
	if (token.includes("\n")) {
		return [];
	}
	const matches = SLASH_COMMANDS.filter((spec) =>
		spec.command.startsWith(token),
	);
	return matches.length > 0 ? matches : SLASH_COMMANDS;
};
