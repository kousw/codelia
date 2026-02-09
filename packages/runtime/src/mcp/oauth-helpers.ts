import type { McpOAuthTokens } from "./auth-store";

type ProtectedResourceMetadata = {
	resource?: string;
	token_endpoint?: string;
	authorization_servers: string[];
	scopes_supported: string[];
};

type AuthorizationServerMetadata = {
	issuer?: string;
	authorization_endpoint?: string;
	token_endpoint?: string;
	registration_endpoint?: string;
	code_challenge_methods_supported: string[];
	scopes_supported: string[];
};

export type DiscoveredOAuthConfig = {
	authorization_url?: string;
	token_url?: string;
	registration_url?: string;
	resource?: string;
	scope?: string;
	code_challenge_methods_supported?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parseStringArray = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
};

const parseProtectedResourceMetadata = (
	value: unknown,
): ProtectedResourceMetadata | null => {
	if (!isRecord(value)) return null;
	return {
		...(typeof value.resource === "string" ? { resource: value.resource } : {}),
		...(typeof value.token_endpoint === "string"
			? { token_endpoint: value.token_endpoint }
			: {}),
		authorization_servers: parseStringArray(value.authorization_servers),
		scopes_supported: parseStringArray(value.scopes_supported),
	};
};

const parseAuthorizationServerMetadata = (
	value: unknown,
): AuthorizationServerMetadata | null => {
	if (!isRecord(value)) return null;
	return {
		...(typeof value.issuer === "string" ? { issuer: value.issuer } : {}),
		...(typeof value.authorization_endpoint === "string"
			? { authorization_endpoint: value.authorization_endpoint }
			: {}),
		...(typeof value.token_endpoint === "string"
			? { token_endpoint: value.token_endpoint }
			: {}),
		...(typeof value.registration_endpoint === "string"
			? { registration_endpoint: value.registration_endpoint }
			: {}),
		code_challenge_methods_supported: parseStringArray(
			value.code_challenge_methods_supported,
		),
		scopes_supported: parseStringArray(value.scopes_supported),
	};
};

const buildAuthorizationServerMetadataUrl = (
	issuer: string,
): string | undefined => {
	try {
		const parsed = new URL(issuer);
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		const basePath = path.startsWith("/") ? path : `/${path}`;
		const metadataPath = `/.well-known/oauth-authorization-server${basePath}`;
		return new URL(metadataPath, `${parsed.origin}/`).toString();
	} catch {
		return undefined;
	}
};

export const parseTokenResponse = (
	value: unknown,
	current?: McpOAuthTokens,
): McpOAuthTokens => {
	if (!isRecord(value) || typeof value.access_token !== "string") {
		throw new Error("OAuth token response missing access_token");
	}
	const expiresIn =
		typeof value.expires_in === "number" && Number.isFinite(value.expires_in)
			? value.expires_in
			: undefined;
	const expiresAt = expiresIn
		? Date.now() + Math.round(expiresIn * 1000)
		: current?.expires_at;
	return {
		access_token: value.access_token,
		...(typeof value.refresh_token === "string"
			? { refresh_token: value.refresh_token }
			: current?.refresh_token
				? { refresh_token: current.refresh_token }
				: {}),
		...(typeof value.token_type === "string"
			? { token_type: value.token_type }
			: current?.token_type
				? { token_type: current.token_type }
				: {}),
		...(typeof value.scope === "string"
			? { scope: value.scope }
			: current?.scope
				? { scope: current.scope }
				: {}),
		...(current?.client_id ? { client_id: current.client_id } : {}),
		...(current?.client_secret ? { client_secret: current.client_secret } : {}),
		...(expiresAt ? { expires_at: expiresAt } : {}),
	};
};

export const fetchDiscoveredOAuthConfig = async (
	serverUrl: string,
): Promise<DiscoveredOAuthConfig> => {
	try {
		const parsedUrl = new URL(serverUrl);
		const protectedMetadataUrl = new URL(
			"/.well-known/oauth-protected-resource",
			parsedUrl.origin,
		);
		protectedMetadataUrl.searchParams.set("resource", serverUrl);
		const response = await fetch(protectedMetadataUrl, {
			headers: {
				Accept: "application/json",
			},
		});
		if (!response.ok) return {};
		const protectedMetadata = parseProtectedResourceMetadata(
			(await response.json()) as unknown,
		);
		if (!protectedMetadata) return {};

		let resolved: DiscoveredOAuthConfig = {
			...(protectedMetadata.token_endpoint
				? { token_url: protectedMetadata.token_endpoint }
				: {}),
			...(protectedMetadata.resource
				? { resource: protectedMetadata.resource }
				: {}),
			...(protectedMetadata.scopes_supported.length
				? { scope: protectedMetadata.scopes_supported.join(" ") }
				: {}),
		};

		for (const issuer of protectedMetadata.authorization_servers) {
			const primary = buildAuthorizationServerMetadataUrl(issuer);
			const fallback = (() => {
				try {
					return new URL(
						"/.well-known/oauth-authorization-server",
						issuer,
					).toString();
				} catch {
					return undefined;
				}
			})();
			const candidates = [primary, fallback].filter(
				(entry): entry is string => !!entry,
			);
			for (const metadataUrl of candidates) {
				try {
					const metadataRes = await fetch(metadataUrl, {
						headers: {
							Accept: "application/json",
						},
					});
					if (!metadataRes.ok) continue;
					const metadata = parseAuthorizationServerMetadata(
						(await metadataRes.json()) as unknown,
					);
					if (!metadata) continue;
					resolved = {
						...resolved,
						...(metadata.authorization_endpoint
							? { authorization_url: metadata.authorization_endpoint }
							: {}),
						...(metadata.token_endpoint
							? { token_url: metadata.token_endpoint }
							: {}),
						...(metadata.registration_endpoint
							? { registration_url: metadata.registration_endpoint }
							: {}),
						...(metadata.code_challenge_methods_supported.length
							? {
									code_challenge_methods_supported:
										metadata.code_challenge_methods_supported,
								}
							: {}),
						...(metadata.scopes_supported.length
							? { scope: metadata.scopes_supported.join(" ") }
							: {}),
					};
					if (resolved.authorization_url && resolved.token_url) {
						return resolved;
					}
				} catch {
					// continue with next metadata candidate
				}
			}
		}

		return resolved;
	} catch {
		return {};
	}
};
