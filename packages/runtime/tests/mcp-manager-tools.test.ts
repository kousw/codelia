import { describe, expect, test } from "bun:test";
import type { ResolvedMcpServerConfig } from "../src/config";
import type { McpClient } from "../src/mcp/client";
import { McpManager } from "../src/mcp/manager";

type StdioTestConfig = ResolvedMcpServerConfig & {
	transport: "stdio";
	command: string;
	args: string[];
};

describe("McpManager tool adapter", () => {
	test("marks MCP tools as non-strict", () => {
		const manager = new McpManager({
			workingDir: process.cwd(),
			log: () => {},
		});

		const client: McpClient = {
			request: async () => ({ ok: true }),
			notify: async () => undefined,
			close: async () => undefined,
		};

		const config: StdioTestConfig = {
			id: "filesystem-local",
			source: "project",
			enabled: true,
			transport: "stdio",
			command: "echo",
			args: [],
			request_timeout_ms: 30_000,
		};

		const tool = (
			manager as unknown as {
				createToolAdapter: (
					serverId: string,
					tool: { name: string; description?: string; inputSchema?: unknown },
					config: StdioTestConfig,
					client: McpClient,
				) => {
					definition: { strict?: boolean };
				};
			}
		).createToolAdapter(
			"filesystem-local",
			{
				name: "read_file",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string" },
					},
				},
			},
			config,
			client,
		);

		expect(tool.definition.strict).toBe(false);
	});
});
