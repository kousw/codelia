import type {
	Response,
	ResponseOutputItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { safeJsonStringify } from "../provider-log";
import {
	extractOutputText,
	getResponseStreamEventDebugPayload,
} from "./response-utils";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const envTruthy = (value?: string): boolean => {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
};

const loggedUnhandledResponseEventTypes = new Set<string>();

const cloneValue = <T>(value: T): T => {
	if (typeof structuredClone === "function") {
		return structuredClone(value);
	}
	return JSON.parse(JSON.stringify(value)) as T;
};

const cloneResponse = (response: Response): Response => cloneValue(response);

const cloneOutputItem = (item: ResponseOutputItem): ResponseOutputItem =>
	cloneValue(item);

const ensureArrayIndex = <T>(
	array: Array<T | undefined>,
	index: number,
): void => {
	while (array.length <= index) {
		array.push(undefined);
	}
};

export class OpenAiResponseAccumulator {
	private baseResponse: Response | null = null;
	private terminalResponse: Response | null = null;
	private readonly outputItems: Array<ResponseOutputItem | undefined> = [];

	observeEvent(event: ResponseStreamEvent): void {
		switch (event.type) {
			case "response.created":
			case "response.queued":
			case "response.in_progress":
			case "response.incomplete": {
				this.seedBaseResponse(event.response);
				break;
			}
			case "response.output_item.added":
			case "response.output_item.done": {
				this.setOutputItem(event.output_index, event.item);
				break;
			}
			case "response.content_part.added": {
				this.addContentPart(
					event.output_index,
					event.content_index,
					event.part,
				);
				break;
			}
			case "response.output_text.delta": {
				this.appendMessageText(
					event.output_index,
					event.content_index,
					event.delta,
				);
				break;
			}
			case "response.output_text.done": {
				this.setMessageText(
					event.output_index,
					event.content_index,
					event.text,
				);
				break;
			}
			case "response.refusal.delta": {
				this.appendRefusalText(
					event.output_index,
					event.content_index,
					event.delta,
				);
				break;
			}
			case "response.refusal.done": {
				this.setRefusalText(
					event.output_index,
					event.content_index,
					event.refusal,
				);
				break;
			}
			case "response.function_call_arguments.delta": {
				this.appendFunctionCallArguments(event.output_index, event.delta);
				break;
			}
			case "response.function_call_arguments.done": {
				this.setFunctionCallArguments(
					event.output_index,
					event.name,
					event.arguments,
				);
				break;
			}
			case "response.reasoning_summary_part.added":
			case "response.reasoning_summary_part.done": {
				this.setReasoningSummaryPart(
					event.output_index,
					event.summary_index,
					event.part.text,
				);
				break;
			}
			case "response.reasoning_summary_text.delta": {
				this.appendReasoningSummaryText(
					event.output_index,
					event.summary_index,
					event.delta,
				);
				break;
			}
			case "response.reasoning_summary_text.done": {
				this.setReasoningSummaryText(
					event.output_index,
					event.summary_index,
					event.text,
				);
				break;
			}
			case "response.reasoning_text.delta": {
				this.appendReasoningText(
					event.output_index,
					event.content_index,
					event.delta,
				);
				break;
			}
			case "response.reasoning_text.done": {
				this.setReasoningText(
					event.output_index,
					event.content_index,
					event.text,
				);
				break;
			}
			case "response.output_text.annotation.added": {
				this.addOutputTextAnnotation(
					event.output_index,
					event.content_index,
					event.annotation_index,
					event.annotation,
				);
				break;
			}
			case "response.completed": {
				this.observeTerminalResponse(event.response);
				break;
			}
			default: {
				this.logUnhandledResponseEvent(event);
				break;
			}
		}
	}

	observeTerminalResponse(response: Response): void {
		if (!this.baseResponse) {
			this.seedBaseResponse(response);
		}
		this.terminalResponse = cloneResponse(response);
	}

	buildResponse(fallbackResponse?: Response): Response {
		const terminal = fallbackResponse
			? cloneResponse(fallbackResponse)
			: this.terminalResponse
				? cloneResponse(this.terminalResponse)
				: null;
		const base = terminal ?? this.baseResponse;
		if (!base) {
			throw new Error("openai response accumulator has no response snapshot");
		}
		const merged = cloneResponse(base);
		const accumulatedOutput = this.getAccumulatedOutputItems();
		if (accumulatedOutput.length > 0) {
			merged.output = accumulatedOutput;
			const accumulatedText = extractOutputText(accumulatedOutput);
			merged.output_text = accumulatedText;
		}
		return merged;
	}

	private seedBaseResponse(response: Response): void {
		this.baseResponse = cloneResponse(response);
		if (this.outputItems.length === 0 && Array.isArray(response.output)) {
			for (const [index, item] of response.output.entries()) {
				this.outputItems[index] = cloneOutputItem(item);
			}
		}
	}

	private getAccumulatedOutputItems(): ResponseOutputItem[] {
		return this.outputItems.filter(
			(item): item is ResponseOutputItem => item !== undefined,
		);
	}

	private setOutputItem(index: number, item: ResponseOutputItem): void {
		ensureArrayIndex(this.outputItems, index);
		this.outputItems[index] = cloneOutputItem(item);
	}

	private getOutputItem(index: number): ResponseOutputItem | undefined {
		return this.outputItems[index];
	}

	private addContentPart(
		outputIndex: number,
		contentIndex: number,
		part: unknown,
	): void {
		const output = this.getOutputItem(outputIndex);
		if (!output || !isRecord(part)) {
			return;
		}
		if (output.type === "message" && part.type !== "reasoning_text") {
			ensureArrayIndex(output.content, contentIndex);
			output.content[contentIndex] = cloneValue(
				part,
			) as unknown as (typeof output.content)[number];
			return;
		}
		if (output.type === "reasoning" && part.type === "reasoning_text") {
			const content = output.content ?? [];
			ensureArrayIndex(content, contentIndex);
			content[contentIndex] = cloneValue(
				part,
			) as unknown as (typeof content)[number];
			output.content = content;
		}
	}

	private appendMessageText(
		outputIndex: number,
		contentIndex: number,
		delta: string,
	): void {
		const part = this.ensureMessageTextPart(outputIndex, contentIndex);
		if (!part) {
			return;
		}
		part.text += delta;
	}

	private setMessageText(
		outputIndex: number,
		contentIndex: number,
		text: string,
	): void {
		const part = this.ensureMessageTextPart(outputIndex, contentIndex);
		if (!part) {
			return;
		}
		part.text = text;
	}

	private appendRefusalText(
		outputIndex: number,
		contentIndex: number,
		delta: string,
	): void {
		const part = this.ensureMessageRefusalPart(outputIndex, contentIndex);
		if (!part) {
			return;
		}
		part.refusal += delta;
	}

	private setRefusalText(
		outputIndex: number,
		contentIndex: number,
		refusal: string,
	): void {
		const part = this.ensureMessageRefusalPart(outputIndex, contentIndex);
		if (!part) {
			return;
		}
		part.refusal = refusal;
	}

	private appendFunctionCallArguments(
		outputIndex: number,
		delta: string,
	): void {
		const output = this.getOutputItem(outputIndex);
		if (!output || output.type !== "function_call") {
			return;
		}
		output.arguments += delta;
	}

	private setFunctionCallArguments(
		outputIndex: number,
		name: string,
		argumentsText: string,
	): void {
		const output = this.getOutputItem(outputIndex);
		if (!output || output.type !== "function_call") {
			return;
		}
		output.name = name;
		output.arguments = argumentsText;
	}

	private setReasoningSummaryPart(
		outputIndex: number,
		summaryIndex: number,
		text: string,
	): void {
		const summary = this.ensureReasoningSummaryPart(outputIndex, summaryIndex);
		if (!summary) {
			return;
		}
		summary.text = text;
	}

	private appendReasoningSummaryText(
		outputIndex: number,
		summaryIndex: number,
		delta: string,
	): void {
		const summary = this.ensureReasoningSummaryPart(outputIndex, summaryIndex);
		if (!summary) {
			return;
		}
		summary.text += delta;
	}

	private setReasoningSummaryText(
		outputIndex: number,
		summaryIndex: number,
		text: string,
	): void {
		const summary = this.ensureReasoningSummaryPart(outputIndex, summaryIndex);
		if (!summary) {
			return;
		}
		summary.text = text;
	}

	private appendReasoningText(
		outputIndex: number,
		contentIndex: number,
		delta: string,
	): void {
		const content = this.ensureReasoningContentPart(outputIndex, contentIndex);
		if (!content) {
			return;
		}
		content.text += delta;
	}

	private setReasoningText(
		outputIndex: number,
		contentIndex: number,
		text: string,
	): void {
		const content = this.ensureReasoningContentPart(outputIndex, contentIndex);
		if (!content) {
			return;
		}
		content.text = text;
	}

	private addOutputTextAnnotation(
		outputIndex: number,
		contentIndex: number,
		annotationIndex: number,
		annotation: unknown,
	): void {
		const part = this.ensureMessageTextPart(outputIndex, contentIndex);
		if (!part) {
			return;
		}
		ensureArrayIndex(part.annotations, annotationIndex);
		part.annotations[annotationIndex] = cloneValue(annotation);
	}

	private ensureMessageTextPart(
		outputIndex: number,
		contentIndex: number,
	): { type: "output_text"; text: string; annotations: unknown[] } | undefined {
		const output = this.getOutputItem(outputIndex);
		if (!output || output.type !== "message") {
			return undefined;
		}
		ensureArrayIndex(output.content, contentIndex);
		const current = output.content[contentIndex];
		if (!current || current.type !== "output_text") {
			output.content[contentIndex] = {
				type: "output_text",
				text: "",
				annotations: [],
			};
		}
		return output.content[contentIndex] as {
			type: "output_text";
			text: string;
			annotations: unknown[];
		};
	}

	private ensureMessageRefusalPart(
		outputIndex: number,
		contentIndex: number,
	): { type: "refusal"; refusal: string } | undefined {
		const output = this.getOutputItem(outputIndex);
		if (!output || output.type !== "message") {
			return undefined;
		}
		ensureArrayIndex(output.content, contentIndex);
		const current = output.content[contentIndex];
		if (!current || current.type !== "refusal") {
			output.content[contentIndex] = {
				type: "refusal",
				refusal: "",
			};
		}
		return output.content[contentIndex] as {
			type: "refusal";
			refusal: string;
		};
	}

	private ensureReasoningSummaryPart(
		outputIndex: number,
		summaryIndex: number,
	): { type: "summary_text"; text: string } | undefined {
		const output = this.getOutputItem(outputIndex);
		if (!output || output.type !== "reasoning") {
			return undefined;
		}
		ensureArrayIndex(output.summary, summaryIndex);
		if (!output.summary[summaryIndex]) {
			output.summary[summaryIndex] = {
				type: "summary_text",
				text: "",
			};
		}
		return output.summary[summaryIndex] as {
			type: "summary_text";
			text: string;
		};
	}

	private ensureReasoningContentPart(
		outputIndex: number,
		contentIndex: number,
	): { type: "reasoning_text"; text: string } | undefined {
		const output = this.getOutputItem(outputIndex);
		if (!output || output.type !== "reasoning") {
			return undefined;
		}
		const content = output.content ?? [];
		ensureArrayIndex(content, contentIndex);
		if (!content[contentIndex]) {
			content[contentIndex] = {
				type: "reasoning_text",
				text: "",
			};
		}
		output.content = content;
		return content[contentIndex] as { type: "reasoning_text"; text: string };
	}

	private logUnhandledResponseEvent(event: ResponseStreamEvent): void {
		if (
			!envTruthy(process.env.CODELIA_PROVIDER_LOG) &&
			!envTruthy(process.env.CODELIA_DEBUG)
		) {
			return;
		}
		if (!event.type.startsWith("response.")) {
			return;
		}
		if (loggedUnhandledResponseEventTypes.has(event.type)) {
			return;
		}
		loggedUnhandledResponseEventTypes.add(event.type);
		const payload = getResponseStreamEventDebugPayload(event);
		console.error(`[openai.stream.unhandled] ${safeJsonStringify(payload)}`);
	}
}
