import { performance } from "node:perf_hooks";
import { stringifyContent } from "../content/stringify";
import type { AgentServices } from "../di/agent-services";
import { type HistoryAdapter, MessageHistoryAdapter } from "../history";
import type {
	BaseChatModel,
	ChatInvokeContext,
	ChatInvokeInput,
} from "../llm/base";
import { ResponsesHistoryAdapter } from "../llm/openai/history";
import { DEFAULT_MODEL_REGISTRY } from "../models";
import type { ModelRegistry } from "../models/registry";
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
import type { Tool } from "../tools/tool";
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
	ToolChoice,
	ToolDefinition,
	ToolMessage,
	UserMessage,
} from "../types/llm";
import type { ChatInvokeCompletion } from "../types/llm/invoke";
import type { ToolPermissionHook } from "../types/permissions";
import type { AgentSession } from "../types/session-store";
import { calculateContextLeftPercent } from "./model-context";
import { collectModelOutput } from "./model-output";
import { executeToolCall } from "./tool-execution";

const DEFAULT_MAX_ITERATIONS = 200;

const defaultMonotonicNowMs = (): number => performance.now();

const elapsedMilliseconds = (
	startedAt: number,
	monotonicNowMs: () => number,
): number => Math.max(0, Math.round(monotonicNowMs() - startedAt));

export type AgentRunOptions = {
	session?: AgentSession;
	signal?: AbortSignal;
	forceCompaction?: boolean;
	tools?: Tool[];
	toolChoice?: ToolChoice;
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

const isResponsesHistoryProvider = (
	provider: BaseChatModel["provider"],
): boolean => provider === "openai" || provider === "openrouter";

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
	private readonly monotonicNowMs: () => number;
	//private readonly dependencyOverrides?: DependencyOverrides;

	private history: HistoryAdapter;
	private usageService: TokenUsageService;

	constructor(options: AgentOptions) {
		this.llm = options.llm;
		this.history = isResponsesHistoryProvider(this.llm.provider)
			? new ResponsesHistoryAdapter()
			: new MessageHistoryAdapter();
		this.tools = options.tools;
		this.hostedTools = options.hostedTools ?? [];
		this.systemPrompt = options.systemPrompt ?? undefined;
		this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		this.toolChoice = options.toolChoice ?? undefined;
		this.requireDoneTool = options.requireDoneTool ?? false;
		this.services = options.services ?? {};
		this.monotonicNowMs = this.services.monotonicNowMs ?? defaultMonotonicNowMs;
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
		});
		this.canExecuteTool = options.canExecuteTool;
	}

	getUsageSummary(): UsageSummary {
		return this.usageService.getUsageSummary();
	}

	getContextLeftPercent(): number | null {
		return calculateContextLeftPercent({
			usage: this.usageService.getLastUsage(),
			modelRegistry: this.modelRegistry,
			provider: this.llm.provider,
			model: this.llm.model,
		});
	}

	getHistoryMessages(): BaseMessage[] {
		return this.history.getViewMessages();
	}

	replaceHistoryMessages(messages: BaseMessage[]): void {
		this.history.replaceViewMessages(messages);
	}

	private async *checkAndCompact(
		signal?: AbortSignal,
		options: { force?: boolean; session?: AgentSession } = {},
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

			const invokeContext = this.buildInvokeContext(options.session);
			const { compacted, compactedMessages, usage } =
				await this.compactionService.compact(
					this.llm,
					this.history.getViewMessages(),
					{
						...(signal ? { signal } : {}),
						...(invokeContext ? { invokeContext } : {}),
					},
				);
			// update usage summary with compaction usage
			this.usageService.updateUsageSummary(usage);

			if (compacted && compactedMessages) {
				this.history.replaceViewMessages(compactedMessages);
			}
			if (compacted || options.force) {
				await this.llm.onHistoryCompacted?.(invokeContext);
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

	private recordLlmRequest(
		session: AgentSession | undefined,
		input: ChatInvokeInput,
		context?: ChatInvokeContext,
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
				...(context?.sessionKey ? { session_key: context.sessionKey } : {}),
			},
		});
		return seq;
	}

	private resolveSessionKey(session?: AgentSession): string | undefined {
		const sessionId = session?.session_id?.trim();
		if (sessionId && sessionId.length > 0) {
			return sessionId;
		}
		const runId = session?.run_id?.trim();
		return runId && runId.length > 0 ? runId : undefined;
	}

	private buildInvokeContext(
		session?: AgentSession,
	): ChatInvokeContext | undefined {
		const sessionKey = this.resolveSessionKey(session);
		return sessionKey ? { sessionKey } : undefined;
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
			yield* this.checkAndCompact(signal, { force: true, session });
			const finalResponseEvent: FinalResponseEvent = {
				type: "final",
				content: "Compaction run completed.",
			};
			yield finalResponseEvent;
			return;
		}

		this.history.enqueueUserMessage(message);

		let iterations = 0;
		const runTools = [...this.tools, ...(options.tools ?? [])];
		const runToolChoice = options.toolChoice ?? this.toolChoice;
		while (iterations < this.maxIterations) {
			iterations++;
			throwIfAborted(signal);

			await this.trimToolOutputs();
			throwIfAborted(signal);

			const invokeInput = this.history.prepareInvokeInput({
				tools: [...runTools.map((t) => t.definition), ...this.hostedTools],
				toolChoice: runToolChoice,
			});
			const invokeContext = this.buildInvokeContext(session);
			const seq = this.recordLlmRequest(session, invokeInput, invokeContext);
			const response = await this.llm.ainvoke(
				{
					...invokeInput,
					...(signal ? { signal } : {}),
				},
				invokeContext,
			);
			this.recordLlmResponse(session, seq, response);

			// update usage summary with response usage
			this.usageService.updateUsageSummary(response.usage);

			this.history.commitModelResponse(response);
			const { reasoningTexts, assistantTexts, toolCalls, hostedToolCalls } =
				collectModelOutput(response.messages);
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

					yield* this.checkAndCompact(signal, { session });

					// return the final response
					const finalText = assistantTexts.join("\n").trim();
					const finalResponseEvent: FinalResponseEvent = {
						type: "final",
						content: finalText,
					};
					yield finalResponseEvent;
					return;
				} else {
					yield* this.checkAndCompact(signal, { session });
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

				const monotonicStartedAt = this.monotonicNowMs();
				try {
					throwIfAborted(signal);
					const execution = await executeToolCall({
						toolCall,
						tools: runTools,
						...(signal ? { signal } : {}),
						...(this.canExecuteTool
							? { canExecuteTool: this.canExecuteTool }
							: {}),
					});
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

					const durationMs = elapsedMilliseconds(
						monotonicStartedAt,
						this.monotonicNowMs,
					);

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

					const durationMs = elapsedMilliseconds(
						monotonicStartedAt,
						this.monotonicNowMs,
					);

					const stepCompleteEvent: StepCompleteEvent = {
						type: "step_complete",
						step_id: toolCall.id,
						status: "error",
						duration_ms: durationMs,
					};
					yield stepCompleteEvent;
				}
			}

			yield* this.checkAndCompact(signal, { session });
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
			const invokeContext = this.buildInvokeContext(session);
			const seq = this.recordLlmRequest(session, input, invokeContext);
			const summary = await this.llm.ainvoke(
				{
					...input,
					...(signal ? { signal } : {}),
				},
				invokeContext,
			);
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
}
