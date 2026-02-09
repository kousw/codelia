import { useCallback, useRef, useState } from "react";
import type { AgentEvent, ChatMessage } from "../../shared/types";
import {
	cancelRun,
	createRun,
	fetchRunsBySession,
	fetchSessionState,
	streamRunEvents,
} from "../api";
import {
	type HistoryMessage,
	restoreMessagesFromHistory,
} from "./chat-history";

let nextId = 0;
const genId = () => `msg-${++nextId}-${Date.now()}`;

export type StreamPhase =
	| "idle"
	| "connecting"
	| "streaming"
	| "cancelling"
	| "error";

const appendEventToAssistantMessage = (
	prev: ChatMessage[],
	assistantId: string,
	event: AgentEvent,
): ChatMessage[] => {
	const idx = prev.findIndex((message) => message.id === assistantId);
	if (idx === -1) return prev;
	const message = prev[idx];
	const updated = { ...message, events: [...message.events, event] };
	if (event.type === "text") {
		updated.content += event.content;
	} else if (event.type === "final") {
		updated.content = event.content;
	}
	const next = [...prev];
	next[idx] = updated;
	return next;
};

const appendErrorToAssistantMessage = (
	prev: ChatMessage[],
	assistantId: string,
	message: string,
): ChatMessage[] => {
	const idx = prev.findIndex((item) => item.id === assistantId);
	if (idx === -1) return prev;
	const current = prev[idx];
	const next = [...prev];
	next[idx] = {
		...current,
		content: current.content || `Error: ${message}`,
	};
	return next;
};

const replaceAssistantContent = (
	prev: ChatMessage[],
	assistantId: string,
	content: string,
): ChatMessage[] => {
	const idx = prev.findIndex((item) => item.id === assistantId);
	if (idx === -1) return prev;
	const next = [...prev];
	next[idx] = {
		...prev[idx],
		content,
	};
	return next;
};

export const useChat = (sessionId: string | null) => {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [isStreaming, setIsStreaming] = useState(false);
	const [streamPhase, setStreamPhase] = useState<StreamPhase>("idle");
	const [lastError, setLastError] = useState<string | null>(null);
	const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
	const [lastRunDurationMs, setLastRunDurationMs] = useState<number | null>(
		null,
	);
	const abortRef = useRef<AbortController | null>(null);
	const activeRunIdRef = useRef<string | null>(null);
	const runStartRef = useRef<number | null>(null);
	const historyLoadTokenRef = useRef(0);

	const clearActiveRun = useCallback(() => {
		abortRef.current = null;
		activeRunIdRef.current = null;
	}, []);

	const clearRunTiming = useCallback(() => {
		runStartRef.current = null;
		setRunStartedAt(null);
	}, []);

	const markStreamingStarted = useCallback((startedAt: number) => {
		setIsStreaming(true);
		setStreamPhase("connecting");
		runStartRef.current = startedAt;
		setRunStartedAt(startedAt);
	}, []);

	const markStreamingFinished = useCallback(
		(status: string) => {
			setIsStreaming(false);
			clearActiveRun();
			if (runStartRef.current) {
				setLastRunDurationMs(Date.now() - runStartRef.current);
			}
			clearRunTiming();
			setStreamPhase(status === "error" ? "error" : "idle");
		},
		[clearActiveRun, clearRunTiming],
	);

	const markStreamingFailed = useCallback(() => {
		setIsStreaming(false);
		setStreamPhase("error");
		clearActiveRun();
		clearRunTiming();
	}, [clearActiveRun, clearRunTiming]);

	const markStreamingIdle = useCallback(() => {
		setIsStreaming(false);
		setStreamPhase("idle");
		clearActiveRun();
		clearRunTiming();
	}, [clearActiveRun, clearRunTiming]);

	const pushAssistantEvent = useCallback(
		(assistantId: string, event: AgentEvent) => {
			setMessages((prev) =>
				appendEventToAssistantMessage(prev, assistantId, event),
			);
		},
		[],
	);

	const setAssistantSoftError = useCallback(
		(assistantId: string, message: string) => {
			setMessages((prev) =>
				appendErrorToAssistantMessage(prev, assistantId, message),
			);
		},
		[],
	);

	const setAssistantContent = useCallback(
		(assistantId: string, content: string) => {
			setMessages((prev) =>
				replaceAssistantContent(prev, assistantId, content),
			);
		},
		[],
	);

	const loadHistory = useCallback(
		async (sid: string) => {
			const token = ++historyLoadTokenRef.current;
			abortRef.current?.abort();
			markStreamingIdle();
			setLastError(null);
			setLastRunDurationMs(null);
			try {
				const state = await fetchSessionState(sid);
				if (historyLoadTokenRef.current !== token) return;
				let restored = state?.messages?.length
					? restoreMessagesFromHistory(
							state.messages as HistoryMessage[],
							genId,
						)
					: [];

				let activeRun:
					| {
							run_id: string;
							input_text?: string;
							created_at: number;
							started_at?: number;
					  }
					| undefined;
				try {
					const runs = await fetchRunsBySession(sid, {
						statuses: ["queued", "running"],
						limit: 1,
					});
					if (historyLoadTokenRef.current !== token) return;
					activeRun = runs[0];
				} catch {
					activeRun = undefined;
				}

				if (!activeRun) {
					setMessages(restored);
					setIsStreaming(false);
					setStreamPhase("idle");
					setRunStartedAt(null);
					return;
				}

				const inputText = activeRun.input_text?.trim();
				if (inputText && inputText.length > 0) {
					const lastUser = [...restored]
						.reverse()
						.find((msg) => msg.role === "user");
					if (!lastUser || lastUser.content.trim() !== inputText) {
						restored = [
							...restored,
							{
								id: genId(),
								role: "user",
								content: inputText,
								events: [],
								timestamp: Date.now(),
							},
						];
					}
				}

				const assistantId = genId();
				const resumed = [
					...restored,
					{
						id: assistantId,
						role: "assistant" as const,
						content: "",
						events: [],
						timestamp: Date.now(),
					},
				];
				setMessages(resumed);
				markStreamingStarted(
					activeRun.started_at ?? activeRun.created_at ?? Date.now(),
				);
				setLastError(null);
				setLastRunDurationMs(null);
				activeRunIdRef.current = activeRun.run_id;

				const controller = new AbortController();
				abortRef.current = controller;
				try {
					await streamRunEvents(
						activeRun.run_id,
						{
							onOpen: () => {
								if (historyLoadTokenRef.current !== token) return;
								setStreamPhase("streaming");
							},
							onEvent: (event: AgentEvent) => {
								if (historyLoadTokenRef.current !== token) return;
								setStreamPhase("streaming");
								pushAssistantEvent(assistantId, event);
							},
							onDone: (status: string) => {
								if (historyLoadTokenRef.current !== token) return;
								markStreamingFinished(status);
							},
							onError: (message: string) => {
								if (historyLoadTokenRef.current !== token) return;
								setLastError(message);
								setAssistantSoftError(assistantId, message);
							},
						},
						controller.signal,
					);
				} catch {
					if (historyLoadTokenRef.current !== token) return;
					markStreamingFailed();
				}
			} catch {
				if (historyLoadTokenRef.current === token) {
					markStreamingIdle();
					setMessages([]);
				}
			}
		},
		[
			markStreamingIdle,
			markStreamingStarted,
			pushAssistantEvent,
			markStreamingFinished,
			setAssistantSoftError,
			markStreamingFailed,
		],
	);

	const sendMessage = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!sessionId || !trimmed || isStreaming) return;

			const userMsg: ChatMessage = {
				id: genId(),
				role: "user",
				content: trimmed,
				events: [],
				timestamp: Date.now(),
			};
			const assistantId = genId();
			const assistantMsg: ChatMessage = {
				id: assistantId,
				role: "assistant",
				content: "",
				events: [],
				timestamp: Date.now(),
			};

			setLastError(null);
			setLastRunDurationMs(null);
			setMessages((prev) => [...prev, userMsg, assistantMsg]);
			markStreamingStarted(Date.now());

			const controller = new AbortController();
			abortRef.current = controller;

			try {
				const created = await createRun(sessionId, trimmed, controller.signal);
				activeRunIdRef.current = created.runId;
				await streamRunEvents(
					created.runId,
					{
						onOpen: () => {
							setStreamPhase("streaming");
						},
						onEvent: (event: AgentEvent) => {
							setStreamPhase("streaming");
							pushAssistantEvent(assistantId, event);
						},
						onDone: (status: string) => {
							markStreamingFinished(status);
						},
						onError: (message: string) => {
							setLastError(message);
							setAssistantSoftError(assistantId, message);
						},
					},
					controller.signal,
				);
			} catch (error) {
				if ((error as Error).name !== "AbortError") {
					setLastError(String(error));
					setAssistantContent(assistantId, `Error: ${String(error)}`);
					setStreamPhase("error");
				} else {
					setStreamPhase("idle");
				}
				clearActiveRun();
				clearRunTiming();
				setIsStreaming(false);
			}
		},
		[
			sessionId,
			isStreaming,
			markStreamingStarted,
			pushAssistantEvent,
			markStreamingFinished,
			setAssistantSoftError,
			setAssistantContent,
			clearActiveRun,
			clearRunTiming,
		],
	);

	const cancel = useCallback(async () => {
		setStreamPhase("cancelling");
		abortRef.current?.abort();
		abortRef.current = null;
		const runId = activeRunIdRef.current;
		activeRunIdRef.current = null;
		if (runId) {
			try {
				await cancelRun(runId);
			} catch {
				// ignore
			}
		}
		setIsStreaming(false);
		setStreamPhase("idle");
		clearRunTiming();
	}, [clearRunTiming]);

	const clearMessages = useCallback(() => {
		historyLoadTokenRef.current += 1;
		abortRef.current?.abort();
		abortRef.current = null;
		setMessages([]);
		setLastError(null);
		markStreamingIdle();
		setLastRunDurationMs(null);
	}, [markStreamingIdle]);

	return {
		messages,
		isStreaming,
		streamPhase,
		lastError,
		runStartedAt,
		lastRunDurationMs,
		sendMessage,
		cancel,
		loadHistory,
		clearMessages,
	};
};
