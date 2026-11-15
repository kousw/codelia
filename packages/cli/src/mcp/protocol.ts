import {
	assertSupportedMcpProtocolVersion,
	getInitializeProtocolVersion,
	getMcpProtocolVersion,
} from "@codelia/protocol";

export { getInitializeProtocolVersion, getMcpProtocolVersion };

export const assertSupportedProtocolVersion = (value: unknown): void => {
	assertSupportedMcpProtocolVersion(value);
};
