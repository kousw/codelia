import type { ContextUsage } from "@codelia/shared-types";
import type { BaseChatModel } from "../llm/base";
import type { ModelRegistry } from "../models/registry";
import type { ChatInvokeUsage } from "../types/llm/invoke";
import type { BaseMessage, SystemMessage } from "../types/llm/messages";
import type { ToolDefinition } from "../types/llm/tools";
import { estimateImageContext } from "./image-context";
import {
	calculateContextLeftPercent,
	resolveContextLimitTokens,
} from "./model-context";

export type ContextUsageInput = {
	llm: BaseChatModel;
	modelRegistry: ModelRegistry;
	usage: ChatInvokeUsage | null;
	messages: BaseMessage[];
	systemPrompt?: string;
	tools: ToolDefinition[];
};

const categoryOf = (
	message: BaseMessage,
): "system" | "messages" | "tool_results" =>
	message.role === "system"
		? "system"
		: message.role === "tool"
			? "tool_results"
			: "messages";

export const buildContextUsage = (input: ContextUsageInput): ContextUsage => {
	const { llm, modelRegistry, usage } = input;
	const groups: Record<"system" | "messages" | "tool_results", BaseMessage[]> =
		{ system: [], messages: [], tool_results: [] };
	for (const message of input.messages) {
		groups[categoryOf(message)].push(message);
	}
	if (groups.system.length === 0 && input.systemPrompt) {
		const pending: SystemMessage = {
			role: "system",
			content: input.systemPrompt,
		};
		groups.system.push(pending);
	}
	// Images are estimated from part metadata; nothing is fetched or resolved.
	const estimate = (messages: BaseMessage[], tools?: ToolDefinition[]) =>
		estimateImageContext({ messages, tools }, llm, true);
	const baseline = estimate([]).text_tokens;
	const text = (value: number) => Math.max(0, value - baseline);
	const system = estimate(groups.system);
	const conversation = estimate(groups.messages);
	const toolResults = estimate(groups.tool_results);
	const tools = estimate([], input.tools.length ? input.tools : undefined);
	const imageTokens =
		system.image_tokens + conversation.image_tokens + toolResults.image_tokens;
	const imageCount =
		system.image_count + conversation.image_count + toolResults.image_count;
	const limit = resolveContextLimitTokens({
		usage,
		modelRegistry,
		provider: llm.provider,
		model: llm.model,
	});
	return {
		provider: llm.provider,
		model: usage?.model ?? llm.model,
		limit_tokens: limit,
		used_tokens: usage ? usage.total_tokens : null,
		input_tokens: usage ? usage.input_tokens : null,
		left_percent: calculateContextLeftPercent({
			usage,
			modelRegistry,
			provider: llm.provider,
			model: llm.model,
		}),
		basis: usage ? "provider" : "none",
		breakdown: [
			{ category: "system", tokens: text(system.text_tokens) },
			{ category: "tools", tokens: text(tools.text_tokens) },
			{ category: "messages", tokens: text(conversation.text_tokens) },
			{ category: "tool_results", tokens: text(toolResults.text_tokens) },
			{ category: "images", tokens: imageTokens, count: imageCount },
		],
	};
};
