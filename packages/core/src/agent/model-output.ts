import { stringifyContent } from "../content/stringify";
import type { BaseMessage, ToolCall } from "../types/llm";

type HostedToolCall = {
	id: string;
	tool: string;
	displayName: string;
	args: Record<string, unknown>;
	result: string;
	isError: boolean;
};

export type CollectedModelOutput = {
	reasoningTexts: string[];
	assistantTexts: string[];
	toolCalls: ToolCall[];
	hostedToolCalls: HostedToolCall[];
};

type HostedSearchKind = "web" | "x";

type HostedSearchAggregate = {
	id: string;
	kind: HostedSearchKind;
	status: string;
	queries: string[];
	sourcesCount?: number;
};

const buildHostedSearchSummary = (
	kind: HostedSearchKind,
	status: string,
	queries: string[],
	sourcesCount?: number,
): string => {
	const parts = [`${kind === "x" ? "XSearch" : "WebSearch"} status=${status}`];
	if (queries.length) {
		parts.push(`queries=${queries.join(" | ")}`);
	}
	if (typeof sourcesCount === "number") {
		parts.push(`sources=${sourcesCount}`);
	}
	return parts.join(" | ");
};

export const collectModelOutput = (
	messages: BaseMessage[],
): CollectedModelOutput => {
	const reasoningTexts: string[] = [];
	const assistantTexts: string[] = [];
	const toolCalls: ToolCall[] = [];
	const hostedToolCalls: HostedToolCall[] = [];
	const hostedSearchById = new Map<string, HostedSearchAggregate>();
	const hostedSearchOrder: string[] = [];
	const anonymousSearchCounter: Record<HostedSearchKind, number> = {
		web: 0,
		x: 0,
	};
	const lastAnonymousSearchId: Record<HostedSearchKind, string | null> = {
		web: null,
		x: null,
	};

	for (const message of messages) {
		if (message.role === "reasoning") {
			const raw = message.raw_item;
			if (
				raw &&
				typeof raw === "object" &&
				((raw as Record<string, unknown>).type === "web_search_call" ||
					(raw as Record<string, unknown>).type === "x_search_call")
			) {
				const record = raw as Record<string, unknown>;
				const kind: HostedSearchKind =
					record.type === "x_search_call" ? "x" : "web";
				const statusRaw = record.status;
				const status = typeof statusRaw === "string" ? statusRaw : "completed";
				const action =
					record.action && typeof record.action === "object"
						? (record.action as Record<string, unknown>)
						: null;
				const queries = Array.isArray(action?.queries)
					? action.queries.filter(
							(entry): entry is string =>
								typeof entry === "string" && entry.length > 0,
						)
					: [];
				const sourcesCount = Array.isArray(action?.sources)
					? action.sources.length
					: undefined;
				const explicitId =
					typeof record.id === "string" && record.id.length > 0
						? record.id
						: null;
				let id = explicitId;
				const hasSearchContext =
					queries.length > 0 || typeof sourcesCount === "number";
				if (!id) {
					if (hasSearchContext || status === "failed") {
						anonymousSearchCounter[kind] += 1;
						id = `${kind === "x" ? "x" : "web"}_search_${anonymousSearchCounter[kind]}`;
						if (hasSearchContext) {
							lastAnonymousSearchId[kind] = id;
						}
					} else if (lastAnonymousSearchId[kind]) {
						id = lastAnonymousSearchId[kind];
					}
				}
				if (!id) {
					continue;
				}
				const aggregateKey = `${kind}:${id}`;
				const existing = hostedSearchById.get(aggregateKey);
				if (existing) {
					existing.status = status;
					if (queries.length) {
						existing.queries = queries;
					}
					if (typeof sourcesCount === "number") {
						existing.sourcesCount = sourcesCount;
					}
				} else {
					hostedSearchById.set(aggregateKey, {
						id,
						kind,
						status,
						queries,
						...(typeof sourcesCount === "number" ? { sourcesCount } : {}),
					});
					hostedSearchOrder.push(aggregateKey);
				}
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
		if (message.refusal) {
			assistantTexts.push(message.refusal);
		}
		if (message.tool_calls?.length) {
			toolCalls.push(...message.tool_calls);
		}
	}

	for (const aggregateKey of hostedSearchOrder) {
		const aggregate = hostedSearchById.get(aggregateKey);
		if (!aggregate) {
			continue;
		}
		const args: Record<string, unknown> = {
			status: aggregate.status,
			...(aggregate.queries.length ? { queries: aggregate.queries } : {}),
			...(typeof aggregate.sourcesCount === "number"
				? { sources_count: aggregate.sourcesCount }
				: {}),
		};
		hostedToolCalls.push({
			id: aggregate.id,
			tool: aggregate.kind === "x" ? "x_search" : "web_search",
			displayName: aggregate.kind === "x" ? "XSearch" : "WebSearch",
			args,
			result: buildHostedSearchSummary(
				aggregate.kind,
				aggregate.status,
				aggregate.queries,
				aggregate.sourcesCount,
			),
			isError: aggregate.status === "failed",
		});
	}

	return { reasoningTexts, assistantTexts, toolCalls, hostedToolCalls };
};
