import { GoogleGenAI } from "@google/genai";
import { GOOGLE_DEFAULT_MODEL, GOOGLE_MODELS } from "../../models/google";
import type { ChatInvokeCompletion } from "../../types/llm/invoke";
import { isFunctionToolDefinition } from "../../types/llm/tools";
import type { BaseChatModel, ChatInvokeInput } from "../base";
import { classifyOpenAiCompatibleFailure } from "../failures";
import { LlmStreamTiming } from "../stream-timing";
import { toGoogleInput } from "./serializer";
import { collectGoogleStream } from "./stream";

export type ChatGoogleOptions = {
	apiKey: string;
	model?: string;
	thinkingLevel?: "low" | "medium" | "high" | "xhigh";
	client?: GoogleGenAI;
};

export class ChatGoogle implements BaseChatModel<"google"> {
	readonly provider = "google" as const;
	readonly classifyFailure = (error: unknown) =>
		classifyOpenAiCompatibleFailure("google", error);
	readonly model: string;
	private readonly client: GoogleGenAI;
	private readonly thinkingLevel?: ChatGoogleOptions["thinkingLevel"];

	constructor(options: ChatGoogleOptions) {
		if (!options.apiKey.trim()) throw new Error("Google requires an API key");
		this.model = options.model ?? GOOGLE_DEFAULT_MODEL;
		if (!GOOGLE_MODELS.some((entry) => entry.id === this.model))
			throw new Error(`Unsupported Google model: ${this.model}`);
		this.client = options.client ?? new GoogleGenAI({ apiKey: options.apiKey });
		this.thinkingLevel = options.thinkingLevel;
	}

	async ainvoke(input: ChatInvokeInput): Promise<ChatInvokeCompletion> {
		const model = input.model ?? this.model;
		if (!GOOGLE_MODELS.some((entry) => entry.id === model))
			throw new Error(`Unsupported Google model: ${model}`);
		input.signal?.throwIfAborted();
		const { systemInstruction, steps } = toGoogleInput(input.messages);
		const functions = (input.tools ?? []).filter(isFunctionToolDefinition);
		if (functions.length !== (input.tools ?? []).length)
			throw new Error("Google chat does not support hosted tools");
		const tools = functions.map((tool) => ({
			type: "function" as const,
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
		const toolChoice = input.toolChoice;
		if (
			typeof toolChoice === "string" &&
			!["auto", "required", "none"].includes(toolChoice)
		)
			throw new Error("Google chat does not support forced named tool choice");
		const timing = new LlmStreamTiming();
		const result = await this.client.interactions.create(
			{
				model,
				input: steps as Parameters<
					GoogleGenAI["interactions"]["create"]
				>[0]["input"],
				store: false,
				stream: true,
				automatic_continuation: false,
				...(systemInstruction ? { system_instruction: systemInstruction } : {}),
				...(tools.length && toolChoice !== "none" ? { tools } : {}),
				generation_config: {
					max_output_tokens: 65_536,
					...(this.thinkingLevel ? { thinking_level: this.thinkingLevel } : {}),
					...(toolChoice && tools.length
						? { tool_choice: toolChoice === "required" ? "any" : toolChoice }
						: {}),
				},
			},
			{
				...(input.signal ? { signal: input.signal } : {}),
				retries: { strategy: "none" },
			},
		);
		input.signal?.throwIfAborted();
		return collectGoogleStream(result, model, input.onDelta, timing);
	}
}
