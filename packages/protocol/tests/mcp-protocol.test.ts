import { describe, expect, test } from "bun:test";
import {
	assertSupportedMcpProtocolVersion,
	getInitializeProtocolVersion,
	getMcpProtocolVersion,
	isSupportedMcpProtocolVersion,
} from "../src/mcp-protocol";

describe("mcp protocol helpers", () => {
	test("reads initialize protocol version", () => {
		expect(
			getInitializeProtocolVersion({ protocolVersion: "2025-11-25" }),
		).toBe("2025-11-25");
		expect(
			getInitializeProtocolVersion({ protocol_version: "2025-06-18" }),
		).toBe("2025-06-18");
		expect(getInitializeProtocolVersion({})).toBeUndefined();
	});

	test("validates supported versions", () => {
		expect(isSupportedMcpProtocolVersion(getMcpProtocolVersion())).toBe(true);
		expect(isSupportedMcpProtocolVersion("2025-06-18")).toBe(true);
		expect(isSupportedMcpProtocolVersion("2024-01-01")).toBe(false);
	});

	test("throws on unsupported initialize version", () => {
		expect(() =>
			assertSupportedMcpProtocolVersion({
				protocolVersion: "2024-01-01",
			}),
		).toThrow(/unsupported protocol version/);
	});
});
