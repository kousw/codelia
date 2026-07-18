import { describe, expect, test } from "bun:test";
import { ChatXai, type Tool } from "@codelia/core";
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
	providers = ["openai", "anthropic"],
): ResolvedSearchConfig => ({
	mode,
	native: {
		providers,
		searchContextSize: "medium",
	},
	local: {
		backend: "ddg",
		braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
	},
	xai: {
		xSearch: { enabled: false },
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

	test("uses xAI native Responses web search", async () => {
		const result = await composeRuntimeTools({
			provider: "xai",
			baseTools: [tool("read")],
			mcpTools: [],
			hostTools: [],
			searchConfig: searchConfig("native", ["xai"]),
		});

		expect(result.tools.map((entry) => entry.name)).toEqual(["read"]);
		expect(result.hostedTools).toEqual([
			expect.objectContaining({
				type: "hosted_search",
				name: "web_search",
				provider: "xai",
			}),
		]);
	});

	test("serializes xAI web search without unsupported shared options", async () => {
		const config = searchConfig("native", ["xai"]);
		config.native.allowedDomains = ["example.com"];
		config.native.userLocation = {
			country: "JP",
			timezone: "Asia/Tokyo",
		};
		const composition = await composeRuntimeTools({
			provider: "xai",
			baseTools: [],
			mcpTools: [],
			hostTools: [],
			searchConfig: config,
		});
		const requests: Array<{ tools?: unknown }> = [];
		const chat = new ChatXai({
			client: {
				responses: {
					stream: (request: { tools?: unknown }) => {
						requests.push(request);
						return {
							finalResponse: async () => ({
								id: "resp_xai_web_search",
								model: "grok-4.5",
								output: [],
								output_text: "done",
								status: "completed",
								usage: null,
								incomplete_details: null,
							}),
						};
					},
				},
			} as never,
		});

		await chat.ainvoke({
			messages: [{ role: "user", content: "search" }],
			tools: composition.hostedTools,
		});

		expect(composition.hostedTools).toEqual([
			expect.objectContaining({
				search_context_size: "medium",
				user_location: { country: "JP", timezone: "Asia/Tokyo" },
			}),
		]);
		expect(requests[0]?.tools).toEqual([
			{
				type: "web_search",
				filters: { allowed_domains: ["example.com"] },
			},
		]);
	});

	test("adds opt-in X Search independently of local web search", async () => {
		const config = searchConfig("local", ["xai"]);
		config.xai.xSearch = {
			enabled: true,
			allowedXHandles: ["xai"],
			fromDate: "2026-01-01",
			enableImageUnderstanding: true,
		};
		const result = await composeRuntimeTools({
			provider: "xai",
			baseTools: [tool("read")],
			mcpTools: [],
			hostTools: [],
			searchConfig: config,
		});

		expect(result.tools.map((entry) => entry.name)).toEqual(["read", "search"]);
		expect(result.hostedTools).toEqual([
			{
				type: "hosted_search",
				search_kind: "x",
				name: "x_search",
				provider: "xai",
				allowed_x_handles: ["xai"],
				from_date: "2026-01-01",
				enable_image_understanding: true,
			},
		]);
	});

	test("ignores X Search configuration for non-xAI providers", async () => {
		const config = searchConfig("local");
		config.xai.xSearch = { enabled: true };
		const result = await composeRuntimeTools({
			provider: "openai",
			baseTools: [],
			mcpTools: [],
			hostTools: [],
			searchConfig: config,
		});

		expect(result.hostedTools).toEqual([]);
		expect(result.tools.map((entry) => entry.name)).toEqual(["search"]);
	});
});
