const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_COMPATIBLE_PROTOCOL_VERSIONS = new Set([
	MCP_PROTOCOL_VERSION,
	"2025-06-18",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const getMcpProtocolVersion = (): string => MCP_PROTOCOL_VERSION;

export const getMcpCompatibleProtocolVersions = (): string[] =>
	Array.from(MCP_COMPATIBLE_PROTOCOL_VERSIONS);

export const getInitializeProtocolVersion = (
	value: unknown,
): string | undefined => {
	if (!isRecord(value)) return undefined;
	if (typeof value.protocolVersion === "string") return value.protocolVersion;
	if (typeof value.protocol_version === "string") return value.protocol_version;
	return undefined;
};

export const isSupportedMcpProtocolVersion = (version: string): boolean =>
	MCP_COMPATIBLE_PROTOCOL_VERSIONS.has(version);

export const assertSupportedMcpProtocolVersion = (value: unknown): void => {
	const protocolVersion = getInitializeProtocolVersion(value);
	if (!protocolVersion) return;
	if (isSupportedMcpProtocolVersion(protocolVersion)) return;
	throw new Error(
		`unsupported protocol version: ${protocolVersion} (supported: ${getMcpCompatibleProtocolVersions().join(", ")})`,
	);
};
