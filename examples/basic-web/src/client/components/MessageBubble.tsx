import type {
	AgentEvent,
	ChatMessage,
	ToolCallEvent,
	ToolResultEvent,
} from "../../shared/types";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolCallCard } from "./ToolCallCard";

type Props = {
	message: ChatMessage;
};

type ToolPair = {
	call: ToolCallEvent;
	result?: ToolResultEvent;
};

const collectToolPairs = (events: AgentEvent[]): ToolPair[] => {
	const pairs: ToolPair[] = [];
	const callMap = new Map<string, number>();
	for (const event of events) {
		if (event.type === "tool_call") {
			callMap.set(event.tool_call_id, pairs.length);
			pairs.push({ call: event });
		} else if (event.type === "tool_result") {
			const idx = callMap.get(event.tool_call_id);
			if (idx !== undefined) {
				pairs[idx].result = event;
			}
		}
	}
	return pairs;
};

const collectReasoning = (events: AgentEvent[]): string[] =>
	events
		.filter((event) => event.type === "reasoning")
		.map((event) => (event as { content: string }).content);

const formatTimestamp = (timestamp: number): string => {
	try {
		return new Date(timestamp).toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return "";
	}
};

export const MessageBubble = ({ message }: Props) => {
	const isUser = message.role === "user";
	const toolPairs = isUser ? [] : collectToolPairs(message.events);
	const reasoning = isUser ? [] : collectReasoning(message.events);

	return (
		<article className={`az-msg az-msg-${message.role}`}>
			<div className="az-msg-surface">
				<header className="az-msg-header">
					<span className="az-msg-role">{isUser ? "You" : "Agent"}</span>
					<span className="az-msg-time">
						{formatTimestamp(message.timestamp)}
					</span>
				</header>
				<div className="az-msg-body">
					{reasoning.length > 0 ? (
						<ReasoningBlock content={reasoning.join("")} />
					) : null}

					{toolPairs.map((pair) => (
						<ToolCallCard
							key={pair.call.tool_call_id}
							call={pair.call}
							result={pair.result}
						/>
					))}

					{message.content ? (
						<div className="az-msg-content">{message.content}</div>
					) : isUser || message.events.length > 0 ? null : (
						<div className="az-msg-placeholder">Waiting for response...</div>
					)}
				</div>
			</div>
		</article>
	);
};
