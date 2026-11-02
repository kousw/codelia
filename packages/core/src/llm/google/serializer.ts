import type { ChatInvokeCompletion } from "../../types/llm/invoke";
import type { BaseMessage } from "../../types/llm/messages";
import type { ContentPart } from "../../types/llm/content";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: null;
const text = (content: string | ContentPart[] | null): string =>
	typeof content === "string"
		? content
		: (content ?? [])
				.filter(
					(part): part is Extract<ContentPart, { type: "text" }> =>
						part.type === "text",
				)
				.map((part) => part.text)
				.join("\n");

function googleContent(content: string | ContentPart[] | null): RecordValue[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return (content ?? []).map((part) => {
		if (part.type === "text") return { type: "text", text: part.text };
		if (part.type === "image_url") {
			const match =
				/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
					part.image_url.url,
				);
			if (
				!match ||
				(part.image_url.media_type && part.image_url.media_type !== match[1])
			)
				throw new Error(
					"Google image input requires a matching inline data URL",
				);
			return { type: "image", mime_type: match[1], data: match[2] };
		}
		throw new Error(`Unsupported Google input content: ${part.type}`);
	});
}

/** Keep Google-generated steps verbatim in Codelia's durable message history. */
export function toGoogleInput(messages: BaseMessage[]): {
	systemInstruction?: string;
	steps: RecordValue[];
} {
	const system: string[] = [];
	const steps: RecordValue[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			system.push(text(message.content));
			continue;
		}
		if (message.role === "user") {
			steps.push({
				type: "user_input",
				content: googleContent(message.content),
			});
			continue;
		}
		if (message.role === "reasoning") {
			const raw = record(message.raw_item);
			if (raw?.type === "thought") steps.push(structuredClone(raw));
			continue;
		}
		if (message.role === "tool") {
			steps.push({
				type: "function_result",
				call_id: message.tool_call_id,
				name: message.tool_name,
				result:
					typeof message.content === "string"
						? message.content
						: googleContent(message.content),
				...(message.is_error ? { is_error: true } : {}),
			});
			continue;
		}
		const raw = record(message.provider_meta);
		if (
			raw?.type === "model_output" ||
			(raw?.type === "function_call" &&
				message.tool_calls?.some((call) => call.id === raw.id))
		) {
			steps.push(structuredClone(raw));
			continue;
		}
		if (message.content) {
			steps.push({
				type: "model_output",
				content: googleContent(message.content),
			});
		}
		for (const call of message.tool_calls ?? []) {
			steps.push({
				type: "function_call",
				id: call.id,
				name: call.function.name,
				arguments: JSON.parse(call.function.arguments),
			});
		}
	}
	return {
		...(system.length ? { systemInstruction: system.join("\n\n") } : {}),
		steps,
	};
}

const token = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** A nonterminal or unrecognized response cannot become a successful Agent turn. */
export function fromGoogleInteraction(
	value: unknown,
	requestedModel: string,
): ChatInvokeCompletion {
	const interaction = record(value);
	if (!interaction || !Array.isArray(interaction.steps))
		throw new Error("Google returned an incomplete interaction");
	const messages: BaseMessage[] = [];
	let calls = 0;
	let outputs = 0;
	for (const value of interaction.steps) {
		const step = record(value);
		if (!step) throw new Error("Google returned an invalid interaction step");
		if (step.type === "thought") {
			const summary = Array.isArray(step.summary)
				? step.summary
						.map((part) => record(part))
						.filter(
							(part) => part?.type === "text" && typeof part.text === "string",
						)
						.map((part) => part?.text as string)
						.join("\n")
				: "";
			messages.push({ role: "reasoning", content: summary, raw_item: step });
		} else if (step.type === "function_call") {
			if (
				typeof step.id !== "string" ||
				!step.id ||
				typeof step.name !== "string" ||
				!step.name ||
				!record(step.arguments)
			)
				throw new Error("Google returned an invalid function call");
			calls++;
			messages.push({
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: step.id,
						type: "function",
						function: {
							name: step.name,
							arguments: JSON.stringify(step.arguments),
						},
					},
				],
				provider_meta: step,
			});
		} else if (step.type === "model_output") {
			outputs++;
			if (!Array.isArray(step.content))
				throw new Error("Google returned an invalid model output");
			const parts: ContentPart[] = step.content.map((part) => {
				const block = record(part);
				if (block?.type !== "text" || typeof block.text !== "string")
					throw new Error("Google chat returned unsupported output content");
				return { type: "text", text: block.text };
			});
			messages.push({ role: "assistant", content: parts, provider_meta: step });
		} else if (step.type !== "user_input") {
			throw new Error(
				`Google chat returned unsupported step: ${String(step.type)}`,
			);
		}
	}
	if (
		interaction.status !== "completed" &&
		!(interaction.status === "requires_action" && calls > 0)
	)
		throw new Error(
			`Google interaction did not complete: ${String(interaction.status)}`,
		);
	if (
		(interaction.status === "completed" && outputs === 0 && calls === 0) ||
		(interaction.status === "requires_action" && calls === 0)
	)
		throw new Error("Google interaction returned no model output");
	const usage = record(interaction.usage);
	const input = token(usage?.total_input_tokens);
	const output = token(usage?.total_output_tokens);
	const thought = token(usage?.total_thought_tokens);
	return {
		messages,
		stop_reason: interaction.status,
		...(usage
			? {
					usage: {
						model: requestedModel,
						...(typeof interaction.model === "string"
							? { provider_model: interaction.model }
							: {}),
						input_tokens: input,
						input_cached_tokens: token(usage.total_cached_tokens),
						output_tokens: output + thought,
						output_reasoning_tokens: thought,
						total_tokens: token(usage.total_tokens) || input + output + thought,
					},
				}
			: {}),
	};
}
