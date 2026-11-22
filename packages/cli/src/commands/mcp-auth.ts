import { parseArgs } from "node:util";
import { parseEpochMs, parseTimeout } from "../args";
import { readMcpAuth, updateMcpAuth } from "../mcp/auth-file";
import { loadEntriesByScope } from "./mcp-config";

export const runMcpAuthCommand = async (values: string[]): Promise<number> => {
	const [subcommand, ...rest] = values;
	// Credential values are opaque strings, including numeric-looking tokens.
	const parsed = parseArgs({
		args: rest,
		allowPositionals: true,
		options: {
			"access-token": { type: "string" },
			"refresh-token": { type: "string" },
			"expires-at": { type: "string" },
			"expires-in": { type: "string" },
			"token-type": { type: "string" },
			"token-url": { type: "string" },
			"client-id": { type: "string" },
			url: { type: "string" },
			issuer: { type: "string" },
			scope: { type: "string" },
		},
	});
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
		console.log("server_id\tresource_uri\thas_refresh\texpires_at");
		for (const [serverId, entry] of entries) {
			console.log(
				`${serverId}\t${entry.binding.resource_uri}\t${entry.tokens.refresh_token ? "yes" : "no"}\t${entry.tokens.expires_at ?? "-"}`,
			);
		}
		return 0;
	}

	if (subcommand === "set") {
		const serverId = parsed.positionals[0];
		if (!serverId) {
			console.error(
				"usage: codelia mcp auth set <server-id> --access-token <token> [--url <resource-uri>] [--issuer <issuer>] [--token-url <url>] [--client-id <id>] [--refresh-token <token>] [--expires-at <epoch_ms>] [--expires-in <sec>] [--scope <scope>] [--token-type <type>]",
			);
			return 1;
		}
		const accessToken = parsed.values["access-token"];
		if (!accessToken) {
			console.error("--access-token is required");
			return 1;
		}
		const configuredEntries = await loadEntriesByScope("effective").catch(
			() => [],
		);
		const configuredServer = configuredEntries.find(
			(entry) => entry.id === serverId,
		)?.config;
		const resourceUri = parsed.values.url ?? configuredServer?.url;
		if (!resourceUri) {
			console.error(
				"--url is required when the MCP server URL is not configured",
			);
			return 1;
		}
		const { fetchDiscoveredOAuthConfig, resolveMcpServerBinding } =
			await import("@codelia/runtime/sdk");
		const refreshToken = parsed.values["refresh-token"];
		const issuer = parsed.values.issuer;
		const tokenUrl =
			parsed.values["token-url"] ?? configuredServer?.oauth?.token_url;
		const clientId =
			parsed.values["client-id"] ?? configuredServer?.oauth?.client_id;
		const discovered =
			(refreshToken || configuredServer?.oauth || tokenUrl) &&
			(!issuer || !tokenUrl)
				? await fetchDiscoveredOAuthConfig(
						resourceUri,
						AbortSignal.timeout(configuredServer?.request_timeout_ms ?? 30_000),
					)
				: {};
		const binding = resolveMcpServerBinding(
			{ url: resourceUri },
			{
				issuer: issuer ?? discovered.issuer,
				token_url: tokenUrl ?? discovered.token_url,
				authorization_url:
					configuredServer?.oauth?.authorization_url ??
					discovered.authorization_url,
				client_id: clientId,
			},
		);
		if (!binding || (refreshToken && !binding.token_endpoint)) {
			console.error(
				"A valid MCP URL is required. For a refresh token, configure or specify --token-url if discovery is unavailable.",
			);
			return 1;
		}
		const expiresAtRaw = parsed.values["expires-at"];
		const expiresInRaw = parsed.values["expires-in"];
		let expiresAt: number | undefined;
		if (expiresAtRaw) {
			expiresAt = parseEpochMs(expiresAtRaw, "--expires-at");
		} else if (expiresInRaw) {
			expiresAt = Date.now() + parseTimeout(expiresInRaw) * 1000;
		}
		const scope = parsed.values.scope;
		const tokenType = parsed.values["token-type"];
		await updateMcpAuth((auth) => {
			auth.servers[serverId] = {
				binding,
				tokens: {
					access_token: accessToken,
					...(refreshToken ? { refresh_token: refreshToken } : {}),
					...(expiresAt ? { expires_at: expiresAt } : {}),
					...(scope ? { scope } : {}),
					...(tokenType ? { token_type: tokenType } : {}),
					...(clientId ? { client_id: clientId } : {}),
				},
			};
		});
		console.log(`stored MCP auth token for '${serverId}'`);
		return 0;
	}

	if (subcommand === "clear") {
		const serverId = parsed.positionals[0];
		if (!serverId) {
			console.error("usage: codelia mcp auth clear <server-id>");
			return 1;
		}
		const existed = await updateMcpAuth((auth) => {
			if (!auth.servers[serverId]) return false;
			delete auth.servers[serverId];
			return true;
		});
		if (!existed) {
			console.error(`no token found for server: ${serverId}`);
			return 1;
		}
		console.log(`cleared MCP auth token for '${serverId}'`);
		return 0;
	}

	console.error(`unknown auth subcommand: ${subcommand}`);
	return 1;
};
