import { stringifyContent } from "../content/stringify";
import type { AgentServices } from "../di/agent-services";
import { type HistoryAdapter, MessageHistoryAdapter } from "../history";
import type { BaseChatModel, ChatInvokeInput, ProviderName } from "../llm/base";
import { OpenAIHistoryAdapter } from "../llm/openai/history";
import { DEFAULT_MODEL_REGISTRY } from "../models";
import { type ModelRegistry, resolveModel } from "../models/registry";
import {
	type CompactionConfig,
	CompactionService,
} from "../services/compaction";
import {
	type ToolOutputCacheConfig,
	ToolOutputCacheService,
} from "../services/tool-output-cache";
import {
	TokenUsageService,
	type UsageSummary,
} from "../services/usage/service";
import type { DependencyKey, ToolContext } from "../tools/context";
import { TaskComplete } from "../tools/done";
import type { Tool, ToolExecution } from "../tools/tool";
import type {
	AgentEvent,
	CompactionCompleteEvent,
	CompactionStartEvent,
	FinalResponseEvent,
	ReasoningEvent,
	StepCompleteEvent,
	StepStartEvent,
	TextEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "../types/events";
import type {
	BaseMessage,
	ContentPart,
	SystemMessage,
	ToolCall,
	ToolChoice,
	ToolDefinition,
	ToolMessage,
	ToolResult,
	UserMessage,
} from "../types/llm";
import type { ChatInvokeCompletion } from "../types/llm/invoke";
import type { ToolPermissionHook } from "../types/permissions";
import type { AgentSession } from "../types/session-store";

const DEFAULT_MAX_ITERATIONS = 200;

export type AgentRunOptions = {
	session?: AgentSession;
	signal?: AbortSignal;
	forceCompaction?: boolean;
};

export type AgentOptions = {
	llm: BaseChatModel;
	tools: Tool[];
	hostedTools?: ToolDefinition[];

	systemPrompt?: string;
	maxIterations?: number; // default: 200
	toolChoice?: ToolChoice; // default: 'auto'

	// context management
	compaction?: CompactionConfig | null; // default: enabled
	toolOutputCache?: ToolOutputCacheConfig | null; // default: enabled

	// DI services
	services?: AgentServices;

	// model registry
	modelRegistry?: ModelRegistry;

	// usage/cost
	enableUsageTracking?: boolean;

	// dependency overrides (Depends相当)
	//dependencyOverrides?: DependencyOverrides;

	// done tool mode
	requireDoneTool?: boolean; // default: false

	// LLM retry
	llmMaxRetries?: number; // default: 5
	llmRetryBaseDelayMs?: number; // default: 1000
	llmRetryMaxDelayMs?: number; // default: 60000
	llmRetryableStatusCodes?: number[]; // default: [429,500,502,503,504]

	// tool permission hook
	canExecuteTool?: ToolPermissionHook;
};

function toolResultToContent(result: ToolResult): string | ContentPart[] {
	if (result.type === "text") return result.text;
	if (result.type === "parts") return result.parts;
	try {
		return JSON.stringify(result.value);
	} catch {
		return String(result.value);
	}
}

const collectModelOutput = (
	messages: BaseMessage[],
): {
	reasoningTexts: string[];
	assistantTexts: string[];
	toolCalls: ToolCall[];
	hostedToolCalls: Array<{
		id: string;
		tool: string;
		displayName: string;
		args: Record<string, unknown>;
		result: string;
		isError: boolean;
	}>;
} => {
	const reasoningTexts: string[] = [];
	const assistantTexts: string[] = [];
	const toolCalls: ToolCall[] = [];
	const hostedToolCalls: Array<{
		id: string;
		tool: string;
		displayName: string;
		args: Record<string, unknown>;
		result: string;
		isError: boolean;
	}> = [];
	for (const message of messages) {
		if (message.role === "reasoning") {
			const raw = message.raw_item;
			if (
				raw &&
				typeof raw === "object" &&
				(raw as Record<string, unknown>).type === "web_search_call"
			) {
				const record = raw as Record<string, unknown>;
				const statusRaw = record.status;
				const status =
					typeof statusRaw === "string" ? statusRaw : "completed";
				const action =
					record.action && typeof record.action === "object"
						? (record.action as Record<string, unknown>)
						: null;
				const queries = Array.isArray(action?.queries)
					? action?.queries.filter(
							(entry): entry is string =>
								typeof entry === "string" && entry.length > 0,
						)
					: [];
				const sources = Array.isArray(action?.sources)
					? action?.sources
					: [];
				const args: Record<string, unknown> = {
					status,
					...(queries.length ? { queries } : {}),
					...(sources.length ? { sources_count: sources.length } : {}),
				};
				const summaryParts = [`WebSearch status=${status}`];
				if (queries.length) {
					summaryParts.push(`queries=${queries.join(" | ")}`);
				}
				if (sources.length) {
					summaryParts.push(`sources=${sources.length}`);
				}
				const id =
					typeof record.id === "string" && record.id.length > 0
						? record.id
						: `web_search_${hostedToolCalls.length + 1}`;
				hostedToolCalls.push({
					id,
					tool: "web_search",
					displayName: "WebSearch",
					args,
					result: summaryParts.join(" | "),
					isError: status === "failed",
				});
				continue;
			}
			const text = message.content ?? "";
			if (text) {
				reasoningTexts.push(text);
			}
			continue;
		}
		if (message.role !== "assistant") {
			continue;
		}
		if (message.content) {
			const text = stringifyContent(message.content, { mode: "display" });
			if (text) {
				assistantTexts.push(text);
			}
		}
		if (message.tool_calls?.length) {
			toolCalls.push(...message.tool_calls);
		}
	}
	return { reasoningTexts, assistantTexts, toolCalls, hostedToolCalls };
};

const nowIso = (): string => new Date().toISOString();
const createAbortError = (): Error => {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
};

const isAbortError = (error: unknown): boolean =>
	error instanceof Error &&
	(error.name === "AbortError" ||
		error.name === "APIUserAbortError" ||
		error.name === "AbortSignal");

const throwIfAborted = (signal?: AbortSignal): void => {
	if (signal?.aborted) {
		throw createAbortError();
	}
};

export class Agent {
	private readonly llm: BaseChatModel;
	private readonly tools: Tool[];
	private readonly hostedTools: ToolDefinition[];
	private readonly systemPrompt?: string;
	private readonly maxIterations: number;
	private readonly toolChoice?: ToolChoice;
	private readonly requireDoneTool: boolean;
	private readonly compactionService?: CompactionService | null;
	private readonly toolOutputCacheService?: ToolOutputCacheService | null;
	private readonly services: AgentServices;
	private readonly modelRegistry: ModelRegistry;
	private readonly canExecuteTool?: ToolPermissionHook;
	//private readonly dependencyOverrides?: DependencyOverrides;

	private history: HistoryAdapter;
	private usageService: TokenUsageService;

	constructor(options: AgentOptions) {
		this.llm = options.llm;
		this.history =
			this.llm.provider === "openai"
				? new OpenAIHistoryAdapter()
				: new MessageHistoryAdapter();
		this.tools = options.tools;
		this.hostedTools = options.hostedTools ?? [];
		this.systemPrompt = options.systemPrompt ?? undefined;
		this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		this.toolChoice = options.toolChoice ?? undefined;
		this.requireDoneTool = options.requireDoneTool ?? false;
		this.services = options.services ?? {};
		this.modelRegistry = options.modelRegistry ?? DEFAULT_MODEL_REGISTRY;
		this.compactionService =
			options.compaction === null
				? null
				: new CompactionService(options.compaction ?? {}, {
						modelRegistry: this.modelRegistry,
					});
		this.toolOutputCacheService =
			options.toolOutputCache === null
				? null
				: new ToolOutputCacheService(options.toolOutputCache ?? {}, {
						modelRegistry: this.modelRegistry,
						store: this.services.toolOutputCacheStore ?? null,
					});
		this.usageService = new TokenUsageService({
			enabled: options.enableUsageTracking ?? true,
			thresholdRatio: 0.5,
		});
		this.canExecuteTool = options.canExecuteTool;
	}

	getUsageSummary(): UsageSummary {
		return this.usageService.getUsageSummary();
	}

	getContextLeftPercent(): number | null {
		const usage = this.usageService.getLastUsage();
		if (!usage) {
			return null;
		}
		const modelId = usage.model ?? this.llm.model;
		const modelSpec = resolveModelWithQualifiedFallback(
			this.modelRegistry,
			this.llm.provider,
			modelId,
		);
		const contextLimit =
			modelSpec?.contextWindow ?? modelSpec?.maxInputTokens ?? null;
		if (!contextLimit || contextLimit <= 0) {
			return null;
		}
		const used = usage.total_tokens;
		if (!Number.isFinite(used) || used <= 0) {
			return 100;
		}
		const leftRatio = 1 - used / contextLimit;
		const percent = Math.round(leftRatio * 100);
		return Math.max(0, Math.min(100, percent));
	}

	getHistoryMessages(): BaseMessage[] {
		return this.history.getViewMessages();
	}

	replaceHistoryMessages(messages: BaseMessage[]): void {
		this.history.replaceViewMessages(messages);
	}

	private async *checkAndCompact(
		signal?: AbortSignal,
		options: { force?: boolean } = {},
	): AsyncGenerator<AgentEvent> {
		throwIfAborted(signal);
		await this.trimToolOutputs();

		const shouldCompact = options.force
			? true
			: await this.compactionService?.shouldCompact(
					this.llm,
					this.usageService.getLastUsage(),
				);
		if (shouldCompact && this.compactionService) {
			throwIfAborted(signal);
			const startEvent: CompactionStartEvent = {
				type: "compaction_start",
				timestamp: Date.now(),
			};
			yield startEvent;

			const { compacted, compactedMessages, usage } =
				await this.compactionService.compact(
					this.llm,
					this.history.getViewMessages(),
					{ signal },
				);
			// update usage summary with compaction usage
			this.usageService.updateUsageSummary(usage);

			if (compacted && compactedMessages) {
				this.history.replaceViewMessages(compactedMessages);
			}

			const completeEvent: CompactionCompleteEvent = {
				type: "compaction_complete",
				timestamp: Date.now(),
				compacted,
			};
			yield completeEvent;
		}
	}

	private async trimToolOutputs(): Promise<void> {
		if (!this.toolOutputCacheService) return;
		const { messages, trimmed } =
			await this.toolOutputCacheService.trimMessages(
				this.llm,
				this.history.getViewMessages(),
			);
		if (trimmed) {
			this.history.replaceViewMessages(messages);
		}
	}

	private async processToolMessage(message: ToolMessage): Promise<ToolMessage> {
		if (!this.toolOutputCacheService) return message;
		return this.toolOutputCacheService.processToolMessage(message);
	}

	private buildToolContext(signal?: AbortSignal): ToolContext {
		const deps: Record<string, unknown> = Object.create(null);
		const cache = new Map<string, unknown>();
		const resolve = async <T>(key: DependencyKey<T>): Promise<T> => {
			if (cache.has(key.id)) {
				return cache.get(key.id) as T;
			}
			const value = await key.create();
			cache.set(key.id, value);
			return value;
		};
		return {
			deps,
			resolve,
			signal,
			now: () => new Date(),
		};
	}

	private recordLlmRequest(
		session: AgentSession | undefined,
		input: ChatInvokeInput,
	): number | null {
		if (!session) return null;
		const seq = (session.invoke_seq ?? 0) + 1;
		session.invoke_seq = seq;
		const modelName = input.model ?? this.llm.model;
		session.append({
			type: "llm.request",
			run_id: session.run_id,
			ts: nowIso(),
			seq,
			model: {
				provider: this.llm.provider,
				name: modelName,
			},
			input: {
				messages: input.messages,
				tools: input.tools ?? null,
				tool_choice: input.toolChoice ?? null,
				model: input.model,
			},
		});
		return seq;
	}

	private recordLlmResponse(
		session: AgentSession | undefined,
		seq: number | null,
		response: ChatInvokeCompletion,
	): void {
		if (!session || seq === null) return;
		session.append({
			type: "llm.response",
			run_id: session.run_id,
			ts: nowIso(),
			seq,
			output: {
				messages: response.messages,
				usage: response.usage ?? null,
				stop_reason: response.stop_reason ?? null,
				provider_meta: response.provider_meta ?? null,
			},
		});
	}

	async run(
		message: string | ContentPart[],
		options: AgentRunOptions = {},
	): Promise<string> {
		let finalResponse = "";
		for await (const event of this.runStream(message, options)) {
			if (event.type === "final") {
				finalResponse = event.content;
				break;
			}
		}
		return finalResponse;
	}

	async *runStream(
		message: string | ContentPart[],
		options: AgentRunOptions = {},
	): AsyncGenerator<AgentEvent> {
		const session = options.session;
		const signal = options.signal;
		const forceCompaction = options.forceCompaction ?? false;
		if (this.systemPrompt) {
			const systemMessage: SystemMessage = {
				role: "system",
				content: this.systemPrompt,
			};
			this.history.enqueueSystem(systemMessage);
		}

		if (forceCompaction) {
			yield* this.checkAndCompact(signal, { force: true });
			const finalResponseEvent: FinalResponseEvent = {
				type: "final",
				content: "Compaction run completed.",
			};
			yield finalResponseEvent;
			return;
		}

		this.history.enqueueUserMessage(message);

		let iterations = 0;
		while (iterations < this.maxIterations) {
			iterations++;
			throwIfAborted(signal);

			await this.trimToolOutputs();
			throwIfAborted(signal);

			const invokeInput = this.history.prepareInvokeInput({
				tools: [
					...this.tools.map((t) => t.definition),
					...this.hostedTools,
				],
				toolChoice: this.toolChoice,
			});
			const seq = this.recordLlmRequest(session, invokeInput);
			const response = await this.llm.ainvoke({
				...invokeInput,
				...(signal ? { signal } : {}),
			});
			this.recordLlmResponse(session, seq, response);

			// update usage summary with response usage
			this.usageService.updateUsageSummary(response.usage);

			this.history.commitModelResponse(response);
			const {
				reasoningTexts,
				assistantTexts,
				toolCalls,
				hostedToolCalls,
			} = collectModelOutput(response.messages);
			for (const reasoningText of reasoningTexts) {
				const reasoningEvent: ReasoningEvent = {
					type: "reasoning",
					content: reasoningText,
					timestamp: Date.now(),
				};
				yield reasoningEvent;
			}
			let stepNumber = 0;
			for (const hostedCall of hostedToolCalls) {
				stepNumber++;
				const stepStartEvent: StepStartEvent = {
					type: "step_start",
					step_id: hostedCall.id,
					title: hostedCall.displayName,
					step_number: stepNumber,
				};
				yield stepStartEvent;
				const rawArgs = JSON.stringify(hostedCall.args);
				const toolCallEvent: ToolCallEvent = {
					type: "tool_call",
					tool: hostedCall.tool,
					args: hostedCall.args,
					raw_args: rawArgs,
					tool_call_id: hostedCall.id,
					display_name: hostedCall.displayName,
				};
				yield toolCallEvent;
				const toolResultEvent: ToolResultEvent = {
					type: "tool_result",
					tool: hostedCall.tool,
					result: hostedCall.result,
					tool_call_id: hostedCall.id,
					...(hostedCall.isError ? { is_error: true } : {}),
				};
				yield toolResultEvent;
				const stepCompleteEvent: StepCompleteEvent = {
					type: "step_complete",
					step_id: hostedCall.id,
					status: hostedCall.isError ? "error" : "completed",
					duration_ms: 0,
				};
				yield stepCompleteEvent;
			}
			const hasToolCalls = toolCalls.length > 0;
			const shouldEmitFinalOnly = !hasToolCalls && !this.requireDoneTool;

			// When the response is terminal (no tool calls and requireDoneTool is false),
			// emit only `final` to avoid duplicate `text` + `final` with identical content.
			if (!shouldEmitFinalOnly) {
				for (const assistantText of assistantTexts) {
					const textEvent: TextEvent = {
						type: "text",
						content: assistantText,
						timestamp: Date.now(),
					};
					yield textEvent;
				}
			}

			if (!hasToolCalls) {
				if (!this.requireDoneTool) {
					// TODO: check incomplete todos etc.
					// (optional hook) check incomplete todos etc.
					// const prompt = await getIncompleteWorkPrompt?.(messages, tools)
					// if (prompt && !incompletePrompted) {
					// incompletePrompted = true
					// messages.push({ role: 'user', content: prompt })
					// continue
					// }

					yield* this.checkAndCompact(signal);

					// return the final response
					const finalText = assistantTexts.join("\n").trim();
					const finalResponseEvent: FinalResponseEvent = {
						type: "final",
						content: finalText,
					};
					yield finalResponseEvent;
					return;
				} else {
					yield* this.checkAndCompact(signal);
				}

				// requireDoneTool === true: tool callsが無いだけでは終わらない
				continue;
			}

			for (const toolCall of toolCalls) {
				stepNumber++;

				let jsonArgs: Record<string, unknown>;
				try {
					jsonArgs = JSON.parse(toolCall.function.arguments);
				} catch (e: unknown) {
					if (e instanceof SyntaxError) {
						jsonArgs = { _raw: toolCall.function.arguments };
					} else {
						throw e;
					}
				}

				const stepStartEvent: StepStartEvent = {
					type: "step_start",
					step_id: toolCall.id,
					title: toolCall.function.name,
					step_number: stepNumber,
				};
				yield stepStartEvent;

				const toolCallEvent: ToolCallEvent = {
					type: "tool_call",
					tool: toolCall.function.name,
					args: jsonArgs,
					raw_args: toolCall.function.arguments,
					tool_call_id: toolCall.id,
				};
				yield toolCallEvent;

				const startTime = Date.now();
				try {
					throwIfAborted(signal);
					const execution = await this.executeToolCall(toolCall, signal);
					const rawOutput = stringifyContent(execution.message.content, {
						mode: "display",
					});
					const processedMessage = await this.processToolMessage(
						execution.message,
					);
					if (session) {
						session.append({
							type: "tool.output",
							run_id: session.run_id,
							ts: nowIso(),
							tool: toolCall.function.name,
							tool_call_id: toolCall.id,
							result_raw: rawOutput,
							is_error: processedMessage.is_error,
							output_ref: processedMessage.output_ref,
						});
					}
					this.history.enqueueToolResult(processedMessage);

					const toolResultEvent: ToolResultEvent = {
						type: "tool_result",
						tool: toolCall.function.name,
						result: stringifyContent(processedMessage.content, {
							mode: "display",
						}),
						tool_call_id: toolCall.id,
						is_error: processedMessage.is_error,
					};
					yield toolResultEvent;

					const durationMs = Date.now() - startTime;

					const stepCompleteEvent: StepCompleteEvent = {
						type: "step_complete",
						step_id: toolCall.id,
						status: execution.message.is_error ? "error" : "completed",
						duration_ms: durationMs,
					};
					yield stepCompleteEvent;

					if (execution.done) {
						const finalResponseEvent: FinalResponseEvent = {
							type: "final",
							content:
								execution.finalMessage ?? assistantTexts.join("\n").trim(),
						};
						yield finalResponseEvent;
						return;
					}
				} catch (error) {
					if (isAbortError(error)) {
						throw error;
					}
					const content = `Error: ${error instanceof Error ? error.message : String(error)}`;
					const errorToolMessage: ToolMessage = {
						role: "tool",
						tool_call_id: toolCall.id,
						tool_name: toolCall.function.name,
						content: content,
						is_error: true,
					};
					const processedMessage =
						await this.processToolMessage(errorToolMessage);
					const rawOutput = stringifyContent(errorToolMessage.content, {
						mode: "display",
					});
					if (session) {
						session.append({
							type: "tool.output",
							run_id: session.run_id,
							ts: nowIso(),
							tool: toolCall.function.name,
							tool_call_id: toolCall.id,
							result_raw: rawOutput,
							is_error: true,
							output_ref: processedMessage.output_ref,
						});
					}
					this.history.enqueueToolResult(processedMessage);

					// emit tool result event
					const toolResultEvent: ToolResultEvent = {
						type: "tool_result",
						tool: toolCall.function.name,
						result: stringifyContent(processedMessage.content, {
							mode: "display",
						}),
						tool_call_id: toolCall.id,
						is_error: true,
					};
					yield toolResultEvent;

					const durationMs = Date.now() - startTime;

					const stepCompleteEvent: StepCompleteEvent = {
						type: "step_complete",
						step_id: toolCall.id,
						status: "error",
						duration_ms: durationMs,
					};
					yield stepCompleteEvent;
				}
			}

			yield* this.checkAndCompact(signal);
		}

		const finalResponse = await this.generateFinalResponse(session, signal);
		const finalResponseEvent: FinalResponseEvent = {
			type: "final",
			content: finalResponse,
		};
		yield finalResponseEvent;
		return;
	}

	private async generateFinalResponse(
		session?: AgentSession,
		signal?: AbortSignal,
	): Promise<string> {
		const summaryMessage: UserMessage = {
			role: "user",
			content: `You are generating the final response for the user after the agent reached max iterations. Summarize what was completed, what is pending, and any blockers. Be concise, user-facing, and do not mention internal agent mechanics. If there is a clear next step, suggest it as a short list.`,
		};

		try {
			const input = {
				messages: [...this.history.getViewMessages(), summaryMessage], // temporal messages for summary
				tools: null, // no tools are allowed at this point
				toolChoice: "none",
			};
			const seq = this.recordLlmRequest(session, input);
			const summary = await this.llm.ainvoke({
				...input,
				...(signal ? { signal } : {}),
			});
			this.recordLlmResponse(session, seq, summary);

			// update usage summary with summary usage
			this.usageService.updateUsageSummary(summary.usage);

			const { assistantTexts } = collectModelOutput(summary.messages);
			const finalResponse = `[Max Iterations Reached]\n\n${assistantTexts.join("\n").trim()}`;
			return finalResponse;
		} catch {
			if (signal?.aborted) {
				throw createAbortError();
			}
			return "[Max Iterations Reached]\n\nSummary unavailable due to an internal error.";
		}
	}

	private async executeToolCall(
		toolCall: ToolCall,
		signal?: AbortSignal,
	): Promise<ToolExecution> {
		const toolName = toolCall.function.name;

		const tool = this.tools.find((t) => t.name === toolName);
		if (!tool) {
			return {
				message: {
					role: "tool",
					tool_call_id: toolCall.id,
					tool_name: toolName,
					content: `Error: Unknown tool '${toolName}'`,
					is_error: true,
				} satisfies ToolMessage,
			} satisfies ToolExecution;
		}

		if (this.canExecuteTool) {
			try {
				const decision = await this.canExecuteTool(
					toolCall,
					toolCall.function.arguments,
					this.buildToolContext(signal),
				);
				if (decision.decision === "deny") {
					const deniedContent = `Permission denied${
						decision.reason ? `: ${decision.reason}` : ""
					}`;
					return {
						message: {
							role: "tool",
							tool_call_id: toolCall.id,
							tool_name: toolName,
							content: deniedContent,
							is_error: true,
						} satisfies ToolMessage,
						...(decision.stop_turn
							? {
									done: true,
									finalMessage:
										"Permission request was denied. Turn stopped. Please send your next input to continue.",
								}
							: {}),
					} satisfies ToolExecution;
				}
			} catch (error) {
				return {
					message: {
						role: "tool",
						tool_call_id: toolCall.id,
						tool_name: toolName,
						content: `Permission check failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
						is_error: true,
					} satisfies ToolMessage,
				} satisfies ToolExecution;
			}
		}

		try {
			const result = await tool.executeRaw(
				toolCall.function.arguments,
				this.buildToolContext(signal),
			);

			return {
				message: {
					role: "tool",
					tool_call_id: toolCall.id,
					tool_name: toolName,
					content: toolResultToContent(result),
				} satisfies ToolMessage,
			} satisfies ToolExecution;
		} catch (error) {
			if (error instanceof TaskComplete) {
				return {
					message: {
						role: "tool",
						tool_call_id: toolCall.id,
						tool_name: toolName,
						content: "Task complete",
					} satisfies ToolMessage,
					done: true,
					finalMessage: error.finalMessage,
				} satisfies ToolExecution;
			}
			return {
				message: {
					role: "tool",
					tool_call_id: toolCall.id,
					tool_name: toolName,
					content: `Error: ${error instanceof Error ? error.message : String(error)}`,
					is_error: true,
				} satisfies ToolMessage,
			} satisfies ToolExecution;
		}
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
		providerRaw !== "google"
	) {
		return null;
	}
	return { provider: providerRaw, modelId: rest };
};
