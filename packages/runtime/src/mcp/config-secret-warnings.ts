import type { McpServerConfig } from "@codelia/config";

export type InlineMcpSecretFinding = Readonly<{
	serverId: string;
	field: "oauth.client_secret" | "headers" | "env";
	/** Header name or env var name; never contains secret values. */
	key?: string;
}>;

const SECRET_HEADER_PATTERN =
	/^(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token)$/iu;

const SECRET_KEY_PATTERN =
	/(?:token|secret|apikey|api[-_]?key|password|passwd|credential|auth|cookie|private[-_]?key|bearer)/iu;

const SECRET_VALUE_PREFIX_PATTERN =
	/^(?:bearer\s+\S|basic\s+\S|sk-[a-z0-9_-]{8,}|ghp_[a-z0-9]{10,}|github_pat_|xox[baprs]-|glpat-)/iu;

/**
 * Detect inline secret-like MCP settings in readable `config.json` (spec §9.3).
 * Never returns or logs the secret values themselves.
 */
export const detectInlineMcpConfigSecrets = (
	servers?: Record<string, McpServerConfig>,
): InlineMcpSecretFinding[] => {
	if (!servers) return [];
	const findings: InlineMcpSecretFinding[] = [];
	for (const [serverId, server] of Object.entries(servers)) {
		if (!server) continue;
		if (
			typeof server.oauth?.client_secret === "string" &&
			server.oauth.client_secret.trim().length > 0
		) {
			findings.push({ serverId, field: "oauth.client_secret" });
		}
		if (server.headers) {
			for (const [key, value] of Object.entries(server.headers)) {
				if (typeof value !== "string" || value.trim().length === 0) continue;
				if (
					SECRET_HEADER_PATTERN.test(key) ||
					SECRET_KEY_PATTERN.test(key) ||
					SECRET_VALUE_PREFIX_PATTERN.test(value.trim())
				) {
					findings.push({ serverId, field: "headers", key });
				}
			}
		}
		if (server.env) {
			for (const [key, value] of Object.entries(server.env)) {
				if (typeof value !== "string" || value.trim().length === 0) continue;
				if (
					SECRET_KEY_PATTERN.test(key) ||
					SECRET_VALUE_PREFIX_PATTERN.test(value.trim())
				) {
					findings.push({ serverId, field: "env", key });
				}
			}
		}
	}
	return findings;
};
