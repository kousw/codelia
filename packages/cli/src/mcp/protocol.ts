import {
	assertSupportedMcpProtocolVersion,
	getInitializeProtocolVersion,
	getMcpProtocolVersion,
} from "@codelia/protocol";

export { getMcpProtocolVersion, getInitializeProtocolVersion };

export const assertSupportedProtocolVersion = (value: unknown): void => {
	assertSupportedMcpProtocolVersion(value);
};
