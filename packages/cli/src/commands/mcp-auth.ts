import {
	getLastFlagValue,
	parseCliArgs,
	parseEpochMs,
	parseTimeout,
} from "../args";
import { readMcpAuth, writeMcpAuth } from "../mcp/auth-file";

export const runMcpAuthCommand = async (values: string[]): Promise<number> => {
	const [subcommand, ...rest] = values;
	const parsed = parseCliArgs(rest);
	if (!subcommand) {
		console.error("usage: codelia mcp auth <list|set|clear> ...");
		return 1;
	}

	if (subcommand === "list") {
		const auth = await readMcpAuth();
		const entries = Object.entries(auth.servers).sort(([a], [b]) =>
			a.localeCompare(b),
		);
		if (!entries.length) {
			console.log("no MCP auth tokens configured");
			return 0;
		}
		console.log("server_id\thas_refresh\texpires_at");
		for (const [serverId, tokens] of entries) {
			console.log(
				`${serverId}\t${tokens.refresh_token ? "yes" : "no"}\t${tokens.expires_at ?? "-"}`,
			);
		}
		return 0;
	}

	if (subcommand === "set") {
		const serverId = parsed.positionals[0];
		if (!serverId) {
			console.error(
				"usage: codelia mcp auth set <server-id> --access-token <token> [--refresh-token <token>] [--expires-at <epoch_ms>] [--expires-in <sec>] [--scope <scope>] [--token-type <type>]",
			);
			return 1;
		}
		const accessToken = getLastFlagValue(parsed, "access-token");
		if (!accessToken) {
			console.error("--access-token is required");
			return 1;
		}
		const refreshToken = getLastFlagValue(parsed, "refresh-token");
		const expiresAtRaw = getLastFlagValue(parsed, "expires-at");
		const expiresInRaw = getLastFlagValue(parsed, "expires-in");
		let expiresAt: number | undefined;
		if (expiresAtRaw) {
			expiresAt = parseEpochMs(expiresAtRaw, "--expires-at");
		} else if (expiresInRaw) {
			expiresAt = Date.now() + parseTimeout(expiresInRaw) * 1000;
		}
		const scope = getLastFlagValue(parsed, "scope");
		const tokenType = getLastFlagValue(parsed, "token-type");
		const auth = await readMcpAuth();
		auth.servers[serverId] = {
			access_token: accessToken,
			...(refreshToken ? { refresh_token: refreshToken } : {}),
			...(expiresAt ? { expires_at: expiresAt } : {}),
			...(scope ? { scope } : {}),
			...(tokenType ? { token_type: tokenType } : {}),
		};
		await writeMcpAuth(auth);
		console.log(`stored MCP auth token for '${serverId}'`);
		return 0;
	}

	if (subcommand === "clear") {
		const serverId = parsed.positionals[0];
		if (!serverId) {
			console.error("usage: codelia mcp auth clear <server-id>");
			return 1;
		}
		const auth = await readMcpAuth();
		if (!auth.servers[serverId]) {
			console.error(`no token found for server: ${serverId}`);
			return 1;
		}
		delete auth.servers[serverId];
		await writeMcpAuth(auth);
		console.log(`cleared MCP auth token for '${serverId}'`);
		return 0;
	}

	console.error(`unknown auth subcommand: ${subcommand}`);
	return 1;
};
