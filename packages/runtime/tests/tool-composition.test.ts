import { describe, expect, test } from "bun:test";
import type { Tool } from "@codelia/core";
import type { ResolvedSearchConfig } from "../src/config";
import {
	composeRuntimeTools,
	loadRuntimeHostTools,
} from "../src/tool-composition";

const tool = (name: string): Tool => ({
	name,
	description: name,
	definition: {
		type: "function",
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		strict: false,
	},
	executeRaw: async () => ({ type: "text", text: name }),
});

const searchConfig = (
	mode: ResolvedSearchConfig["mode"],
): ResolvedSearchConfig => ({
	mode,
	native: {
		providers: ["openai", "anthropic"],
		searchContextSize: "medium",
	},
	local: {
		backend: "ddg",
		braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
	},
});

describe("runtime tool composition", () => {
	test("keeps base, local search, MCP, and host tools in runtime order", async () => {
		const hostTools = await loadRuntimeHostTools([
			{ getTools: () => [tool("host_preview")] },
		]);
		const result = await composeRuntimeTools({
			provider: "moonshot",
			baseTools: [tool("read"), tool("edit"), tool("apply_patch")],
			mcpTools: [tool("mcp_lookup")],
			hostTools,
			searchConfig: searchConfig("auto"),
		});

		expect(result.tools.map((entry) => entry.name)).toEqual([
			"read",
			"edit",
			"apply_patch",
			"search",
			"mcp_lookup",
			"host_preview",
		]);
		expect(result.hostedTools).toEqual([]);
		expect(result.hostToolNames).toEqual(new Set(["host_preview"]));
		expect(result.editTool?.name).toBe("edit");
		expect(result.applyPatchTool?.name).toBe("apply_patch");
	});

	test("uses provider-native search without adding a local tool", async () => {
		const result = await composeRuntimeTools({
			provider: "openai",
			baseTools: [tool("read")],
			mcpTools: [],
			hostTools: [],
			searchConfig: searchConfig("auto"),
		});

		expect(result.tools.map((entry) => entry.name)).toEqual(["read"]);
		expect(result.hostedTools).toEqual([
			expect.objectContaining({
				type: "hosted_search",
				name: "web_search",
				provider: "openai",
			}),
		]);
	});

	test("rejects native search for a provider without native support", async () => {
		await expect(
			composeRuntimeTools({
				provider: "zai",
				baseTools: [],
				mcpTools: [],
				hostTools: [],
				searchConfig: searchConfig("native"),
			}),
		).rejects.toThrow("native search is unavailable for provider 'zai'");
	});
});
