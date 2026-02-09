import { describe, expect, test } from "bun:test";
import {
	getMcpCompatibleProtocolVersions,
	getMcpProtocolVersion,
} from "../src/mcp-protocol";

describe("@codelia/protocol contracts", () => {
	test("MCP compatible protocol versions include current version", () => {
		const current = getMcpProtocolVersion();
		const compatible = getMcpCompatibleProtocolVersions();
		expect(compatible).toContain(current);
		expect(compatible).toMatchInlineSnapshot(`
      [
        "2025-11-25",
        "2025-06-18",
      ]
    `);
	});
});
