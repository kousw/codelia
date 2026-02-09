import type { BaseChatModel } from "../../llm/base";
import type { ModelRegistry } from "../../models/registry";
import { resolveModel } from "../../models/registry";
import type {
	AssistantMessage,
	BaseMessage,
	ChatInvokeUsage,
	SystemMessage,
	UserMessage,
} from "../../types/llm";
import type { CompactionConfig } from "./config";

const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_RETAIN_LAST_TURNS = 1;
const DEFAULT_SUMMARY_PROMPT =
	"Summarize the conversation so it can be continued later. Focus on decisions, results, constraints, and next steps. Keep it concise and factual.";
const DEFAULT_RETAIN_PROMPT =
	"List concrete details that must be preserved verbatim. Include tool output refs, file paths, identifiers, commands, TODOs, and any critical decisions.";

export type CompactionDependencies = {
	modelRegistry: ModelRegistry;
};

export type CompactionResult = {
	compacted: boolean;
	compactedMessages: BaseMessage[];
	usage: ChatInvokeUsage | null;
};

type NormalizedCompactionConfig = {
	enabled: boolean;
	auto: boolean;
	thresholdRatio: number;
	model: string | null;
	summaryPrompt: string;
	summaryDirectives: string[];
	retainPrompt: string | null;
	retainDirectives: string[];
	retainLastTurns: number;
};

export class CompactionService {
	private readonly config: NormalizedCompactionConfig;
	private readonly modelRegistry: ModelRegistry;

	constructor(config: CompactionConfig, deps: CompactionDependencies) {
		this.config = CompactionService.normalizeConfig(config);
		this.modelRegistry = deps.modelRegistry;
	}

	async shouldCompact(
		llm: BaseChatModel,
		usage: ChatInvokeUsage | null,
	): Promise<boolean> {
		if (!this.config.enabled) {
			return false;
		}

		if (!this.config.auto) {
			return false;
		}

		if (!usage) {
			return false;
		}

		const contextLimit = await this.resolveContextLimit(llm, usage);
		const threshold = Math.floor(contextLimit * this.config.thresholdRatio);
		return usage.total_tokens >= threshold;
	}

	async compact(
		llm: BaseChatModel,
		messages: BaseMessage[],
		options?: { signal?: AbortSignal },
	): Promise<CompactionResult> {
		if (!this.config.enabled) {
			return {
				compacted: false,
				compactedMessages: messages,
				usage: null,
			};
		}

		const preparedMessages = this.prepareMessagesForSummary(messages);
		const prompt = this.buildCompactionPrompt();
		const interruptMessage: UserMessage = {
			role: "user",
			content: prompt,
		};

		let response: Awaited<ReturnType<BaseChatModel["ainvoke"]>>;
		try {
			response = await llm.ainvoke({
				messages: [...preparedMessages, interruptMessage],
				tools: null,
				toolChoice: "none",
				...(options?.signal ? { signal: options.signal } : {}),
				...(this.config.model ? { model: this.config.model } : {}),
			});
		} catch (error) {
			if (
				error instanceof Error &&
				(error.name === "AbortError" ||
					error.name === "APIUserAbortError" ||
					error.name === "AbortSignal")
			) {
				throw error;
			}
			return {
				compacted: false,
				compactedMessages: messages,
				usage: null,
			};
		}

		const responseText = extractAssistantText(response.messages);
		const parsed = this.parseCompactionResponse(responseText);
		const summary = parsed.summary || parsed.fallbackSummary;
		const retain = parsed.retain;
		if (!summary && !retain) {
			return {
				compacted: false,
				compactedMessages: messages,
				usage: response.usage ?? null,
			};
		}

		const compactedMessages = this.buildCompactedMessages(
			messages,
			retain,
			summary,
		);

		return {
			compacted: true,
			compactedMessages,
			usage: response.usage ?? null,
		};
	}

	private prepareMessagesForSummary(messages: BaseMessage[]): BaseMessage[] {
		if (messages.length === 0) return messages;
		const prepared = messages.map((message) => ({ ...message }));
		const last = prepared[prepared.length - 1];
		if (last.role === "assistant" && last.tool_calls?.length) {
			if (last.content) {
				const replacement: AssistantMessage = {
					role: "assistant",
					content: last.content,
					name: last.name,
				};
				prepared[prepared.length - 1] = replacement;
			} else {
				prepared.pop();
			}
		}
		return prepared;
	}

	private buildCompactionPrompt(): string {
		const lines: string[] = [
			"You are summarizing the conversation for context compaction.",
			"Respond only with the XML-like tags below and nothing else:",
		];

		if (this.config.retainPrompt !== null) {
			lines.push("<retain>...</retain>");
		}
		lines.push("<summary>...</summary>", "");

		if (this.config.retainPrompt !== null) {
			lines.push("Retain instructions:", this.config.retainPrompt.trim());
			lines.push(
				...this.config.retainDirectives.map((directive) => `- ${directive}`),
			);
			lines.push("");
		}

		lines.push("Summary instructions:", this.config.summaryPrompt.trim());
		lines.push(
			...this.config.summaryDirectives.map((directive) => `- ${directive}`),
		);

		return lines.join("\n").trim();
	}

	private parseCompactionResponse(text: string): {
		retain: string;
		summary: string;
		fallbackSummary: string;
	} {
		const retain =
			this.config.retainPrompt === null ? "" : extractTag(text, "retain");
		const summary = extractTag(text, "summary");
		const fallbackSummary = text
			.replace(/<retain>[\s\S]*?<\/retain>/gi, "")
			.replace(/<summary>|<\/summary>/gi, "")
			.trim();
		return {
			retain: retain.trim(),
			summary: summary.trim(),
			fallbackSummary,
		};
	}

	private buildCompactedMessages(
		messages: BaseMessage[],
		retain: string,
		summary: string,
	): BaseMessage[] {
		const systemMessages: SystemMessage[] = [];
		const nonSystemMessages: BaseMessage[] = [];

		for (const message of messages) {
			if (message.role === "system") {
				systemMessages.push(message);
			} else {
				nonSystemMessages.push(message);
			}
		}

		const tail = this.getLastTurns(
			nonSystemMessages,
			this.config.retainLastTurns,
		);

		const compacted: BaseMessage[] = [...systemMessages];

		if (retain) {
			compacted.push({
				role: "user",
				content: retain,
			});
		}

		if (summary) {
			compacted.push({
				role: "user",
				content: summary,
			});
		}

		compacted.push(...tail);
		return compacted;
	}

	private getLastTurns(
		messages: BaseMessage[],
		retainLastTurns: number,
	): BaseMessage[] {
		if (retainLastTurns <= 0) return [];
		let remaining = retainLastTurns;
		let startIndex = 0;

		for (let i = messages.length - 1; i >= 0; i -= 1) {
			if (messages[i].role === "user") {
				remaining -= 1;
				if (remaining === 0) {
					startIndex = i;
					break;
				}
			}
		}

		if (remaining > 0) {
			startIndex = 0;
		}

		return messages.slice(startIndex);
	}

	private async resolveContextLimit(
		llm: BaseChatModel,
		usage: ChatInvokeUsage,
	): Promise<number> {
		const modelId = usage.model ?? llm.model;
		const modelSpec = this.resolveModelSpecWithSnapshotFallback(
			llm.provider,
			modelId,
		);
		if (modelSpec?.contextWindow && modelSpec.contextWindow > 0) {
			return modelSpec.contextWindow;
		}
		if (modelSpec?.maxInputTokens && modelSpec.maxInputTokens > 0) {
			return modelSpec.maxInputTokens;
		}
		throw new Error(
			`Missing context limit for ${llm.provider}/${modelId} in model registry`,
		);
	}

	private resolveModelSpecWithSnapshotFallback(
		provider: BaseChatModel["provider"],
		modelId: string,
	) {
		const direct = resolveModel(this.modelRegistry, modelId, provider);
		if (direct) return direct;
		const baseId = stripSnapshotSuffix(modelId);
		if (!baseId || baseId === modelId) return undefined;
		return resolveModel(this.modelRegistry, baseId, provider);
	}

	private static normalizeConfig(
		config: CompactionConfig,
	): NormalizedCompactionConfig {
		const retainLastTurnsRaw =
			config.retainLastTurns ?? DEFAULT_RETAIN_LAST_TURNS;
		return {
			enabled: config.enabled ?? true,
			auto: config.auto ?? true,
			thresholdRatio: config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO,
			model: config.model ?? null,
			summaryPrompt: config.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT,
			summaryDirectives: config.summaryDirectives ?? [],
			retainPrompt:
				config.retainPrompt === undefined
					? DEFAULT_RETAIN_PROMPT
					: config.retainPrompt,
			retainDirectives: config.retainDirectives ?? [],
			retainLastTurns: Math.max(0, Math.floor(retainLastTurnsRaw)),
		};
	}
}

const extractTag = (text: string, tag: string): string => {
	const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
	const match = text.match(regex);
	return match?.[1]?.trim() ?? "";
};

const stripSnapshotSuffix = (modelId: string): string =>
	modelId.replace(/-[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "");

const extractAssistantText = (messages: BaseMessage[]): string =>
	messages
		.flatMap((message) => {
			if (message.role !== "assistant" || message.content == null) {
				return [];
			}
			if (typeof message.content === "string") {
				return [message.content];
			}
			return [
				message.content
					.map((part) => {
						if (part.type === "text") return part.text;
						if (part.type === "other") {
							try {
								return JSON.stringify(part.payload);
							} catch {
								return String(part.payload);
							}
						}
						return "";
					})
					.join(""),
			];
		})
		.join("\n")
		.trim();
