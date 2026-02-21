import type { BaseChatModel, ProviderName } from "../../llm/base";
import type { ModelRegistry } from "../../models/registry";
import { resolveModel } from "../../models/registry";
import type {
	BaseMessage,
	ContentPart,
	ToolMessage,
	ToolOutputRef,
} from "../../types/llm";
import type { ToolOutputCacheConfig } from "./config";
import type { ToolOutputCacheStore } from "./store";

const DEFAULT_MAX_MESSAGE_BYTES = 50 * 1024;
const DEFAULT_CONTEXT_RATIO = 0.25;
const MIN_CONTEXT_BUDGET = 20_000;
const MAX_CONTEXT_BUDGET = 100_000;
const APPROX_BYTES_PER_TOKEN = 4;

const clamp = (value: number, min: number, max: number): number =>
	Math.max(min, Math.min(max, value));

const contentToText = (content: string | ContentPart[]): string => {
	if (typeof content === "string") return content;
	return content
		.map((part) => {
			switch (part.type) {
				case "text":
					return part.text;
				case "image_url":
					return "[image]";
				case "document":
					return "[document]";
				case "other":
					return `[other:${part.provider}/${part.kind}]`;
				default:
					return "[content]";
			}
		})
		.join("");
};

const estimateTokens = (text: string): number =>
	Math.ceil(Buffer.byteLength(text, "utf8") / APPROX_BYTES_PER_TOKEN);

const shouldBypassImmediateTruncation = (toolName: string): boolean =>
	toolName === "tool_output_cache" || toolName === "tool_output_cache_grep";

const truncateForContext = (
	content: string,
	maxMessageBytes: number,
): { output: string; truncated: boolean } => {
	if (!content) return { output: "", truncated: false };
	const lines = content.split(/\r?\n/);
	const outputLines: string[] = [];
	let bytes = 0;
	let modified = false;

	for (const line of lines) {
		const size = Buffer.byteLength(line, "utf8") + (outputLines.length ? 1 : 0);
		if (bytes + size > maxMessageBytes) {
			modified = true;
			break;
		}
		outputLines.push(line);
		bytes += size;
	}

	return { output: outputLines.join("\n"), truncated: modified };
};

export type ToolOutputCacheDependencies = {
	modelRegistry: ModelRegistry;
	store?: ToolOutputCacheStore | null;
};

export type TrimResult = {
	messages: BaseMessage[];
	trimmed: boolean;
};

export class ToolOutputCacheService {
	private readonly config: ToolOutputCacheConfig;
	private readonly modelRegistry: ModelRegistry;
	private readonly store?: ToolOutputCacheStore | null;

	constructor(
		config: ToolOutputCacheConfig,
		deps: ToolOutputCacheDependencies,
	) {
		this.config = config;
		this.modelRegistry = deps.modelRegistry;
		this.store = deps.store;
	}

	async processToolMessage(message: ToolMessage): Promise<ToolMessage> {
		if (this.config.enabled === false) return message;

		const raw = contentToText(message.content);
		const outputRef = await this.persistToolOutput(message, raw);
		const truncated = shouldBypassImmediateTruncation(message.tool_name)
			? { output: raw, truncated: false }
			: truncateForContext(
					raw,
					this.config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
				);
		const trimmed = truncated.truncated;
		let output = truncated.output;

		if (trimmed) {
			const refLabel = outputRef?.id ? `; ref=${outputRef.id}` : "";
			output += `\n\n[tool output truncated${refLabel}]`;
		}

		return {
			...message,
			content: output,
			output_ref: outputRef,
			trimmed: trimmed || message.trimmed,
		};
	}

	async trimMessages(
		llm: BaseChatModel,
		messages: BaseMessage[],
	): Promise<TrimResult> {
		if (
			this.config.enabled === false ||
			this.config.totalBudgetTrim === false
		) {
			return { messages, trimmed: false };
		}
		const budget = await this.resolveContextBudgetTokens(llm);
		let total = 0;
		for (const message of messages) {
			if (message.role !== "tool") continue;
			total += estimateTokens(contentToText(message.content));
		}
		if (total <= budget) return { messages, trimmed: false };

		const updated = messages.map((message) => ({ ...message }));
		let trimmedAny = false;
		for (const message of updated) {
			if (message.role !== "tool") continue;
			if (total <= budget) break;
			const toolMessage = message as ToolMessage;
			const contentText = contentToText(toolMessage.content);
			const refId = toolMessage.output_ref?.id ?? null;
			const placeholder = refId
				? `[tool output trimmed; ref=${refId}]`
				: "[tool output trimmed]";
			const tokens = estimateTokens(contentText);
			const placeholderTokens = estimateTokens(placeholder);
			toolMessage.content = placeholder;
			toolMessage.trimmed = true;
			total = Math.max(0, total - tokens + placeholderTokens);
			trimmedAny = true;
		}

		return { messages: updated, trimmed: trimmedAny };
	}

	private async persistToolOutput(
		message: ToolMessage,
		content: string,
	): Promise<ToolOutputRef | undefined> {
		if (!this.store) return undefined;
		try {
			const result = await this.store.save({
				tool_call_id: message.tool_call_id,
				tool_name: message.tool_name,
				content,
				is_error: message.is_error,
			});
			return result;
		} catch {
			return undefined;
		}
	}

	private async resolveContextBudgetTokens(
		llm: BaseChatModel,
	): Promise<number> {
		if (
			this.config.contextBudgetTokens !== undefined &&
			this.config.contextBudgetTokens !== null
		) {
			return this.config.contextBudgetTokens;
		}
		const modelSpec = resolveModelWithQualifiedFallback(
			this.modelRegistry,
			llm.provider,
			llm.model,
		);
		const contextLimit =
			modelSpec?.contextWindow ?? modelSpec?.maxInputTokens ?? null;
		if (!contextLimit || contextLimit <= 0) {
			return MAX_CONTEXT_BUDGET;
		}
		const derived = Math.floor(contextLimit * DEFAULT_CONTEXT_RATIO);
		return clamp(derived, MIN_CONTEXT_BUDGET, MAX_CONTEXT_BUDGET);
	}
}

const resolveModelWithQualifiedFallback = (
	modelRegistry: ModelRegistry,
	provider: BaseChatModel["provider"],
	modelId: string,
) => {
	const direct = resolveModel(modelRegistry, modelId, provider);
	if (direct) return direct;

	const qualified = parseQualifiedModelId(modelId);
	if (!qualified) return resolveModel(modelRegistry, modelId);

	return (
		resolveModel(modelRegistry, qualified.modelId, qualified.provider) ??
		resolveModel(
			modelRegistry,
			`${qualified.provider}/${qualified.modelId}`,
			qualified.provider,
		)
	);
};

const parseQualifiedModelId = (
	modelId: string,
): { provider: ProviderName; modelId: string } | null => {
	const sep = modelId.indexOf("/");
	if (sep <= 0 || sep >= modelId.length - 1) {
		return null;
	}
	const providerRaw = modelId.slice(0, sep);
	const rest = modelId.slice(sep + 1);
	if (!rest) {
		return null;
	}
	if (
		providerRaw !== "openai" &&
		providerRaw !== "anthropic" &&
		providerRaw !== "openrouter" &&
		providerRaw !== "google"
	) {
		return null;
	}
	return { provider: providerRaw, modelId: rest };
};
