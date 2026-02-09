import { describe, expect, test } from "bun:test";
import {
	assertSupportedProtocolVersion,
	getInitializeProtocolVersion,
} from "../src/mcp/protocol";

describe("cli mcp protocol compatibility", () => {
	test("getInitializeProtocolVersion reads both casing variants", () => {
		expect(
			getInitializeProtocolVersion({ protocolVersion: "2025-11-25" }),
		).toBe("2025-11-25");
		expect(
			getInitializeProtocolVersion({ protocol_version: "2025-06-18" }),
		).toBe("2025-06-18");
		expect(getInitializeProtocolVersion({})).toBeUndefined();
	});

	test("assertSupportedProtocolVersion accepts compatible versions", () => {
		expect(() =>
			assertSupportedProtocolVersion({ protocolVersion: "2025-11-25" }),
		).not.toThrow();
		expect(() =>
			assertSupportedProtocolVersion({ protocolVersion: "2025-06-18" }),
		).not.toThrow();
		expect(() => assertSupportedProtocolVersion({})).not.toThrow();
	});

	test("assertSupportedProtocolVersion rejects unsupported versions", () => {
		expect(() =>
			assertSupportedProtocolVersion({ protocolVersion: "2099-01-01" }),
		).toThrow(/unsupported protocol version/i);
	});
});
