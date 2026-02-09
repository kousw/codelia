import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ChatMessage } from "../../shared/types";
import type { StreamPhase } from "../hooks/useChat";
import { MessageBubble } from "./MessageBubble";

type Props = {
	messages: ChatMessage[];
	isStreaming: boolean;
	streamPhase: StreamPhase;
	lastError: string | null;
	runStartedAt: number | null;
	lastRunDurationMs: number | null;
	onSend: (text: string) => void;
	onCancel: () => Promise<void> | void;
	onClearMessages: () => void;
	sessionId: string | null;
	onCreateSession: () => Promise<string>;
	onOpenSidebar: () => void;
};

const QUICK_PROMPTS = [
	"TUI implementation plan and risks",
	"Summarize runtime and protocol boundaries",
	"Review current branch and propose next tasks",
	"Find unstable areas around event streaming",
];

const phaseInfo = (phase: StreamPhase): { label: string; detail: string } => {
	switch (phase) {
		case "connecting":
			return { label: "Connecting", detail: "Opening stream connection" };
		case "streaming":
			return { label: "Streaming", detail: "Receiving agent events" };
		case "cancelling":
			return { label: "Cancelling", detail: "Stopping the active run" };
		case "error":
			return { label: "Error", detail: "Check logs and retry" };
		default:
			return { label: "Ready", detail: "Send a new message" };
	}
};

const formatHint = (sessionId: string | null): string => {
	if (!sessionId) return "Create a session to begin";
	return `Active session: ${sessionId}`;
};

export const ChatPanel = ({
	messages,
	isStreaming,
	streamPhase,
	lastError,
	runStartedAt,
	lastRunDurationMs,
	onSend,
	onCancel,
	onClearMessages,
	sessionId,
	onCreateSession,
	onOpenSidebar,
}: Props) => {
	const [input, setInput] = useState("");
	const [busyCreating, setBusyCreating] = useState(false);
	const [localNotice, setLocalNotice] = useState<string | null>(null);
	const [, setElapsedTick] = useState(0);
	const bottomRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const phase = useMemo(() => phaseInfo(streamPhase), [streamPhase]);
	const canSubmit = Boolean(sessionId && input.trim() && !isStreaming);

	useEffect(() => {
		const behavior = messages.length > 0 ? "smooth" : "auto";
		bottomRef.current?.scrollIntoView({ behavior });
	}, [messages.length]);

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "0px";
		el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
	});

	useEffect(() => {
		if (!runStartedAt) return;
		const timer = setInterval(() => {
			setElapsedTick((v) => v + 1);
		}, 1000);
		return () => clearInterval(timer);
	}, [runStartedAt]);

	const commitSend = (text: string) => {
		if (!sessionId || !text.trim() || isStreaming) return;
		onSend(text.trim());
		setInput("");
		setLocalNotice(null);
	};

	const runCommand = async (raw: string): Promise<boolean> => {
		const [name] = raw.trim().slice(1).split(/\s+/);
		switch ((name ?? "").toLowerCase()) {
			case "new":
				setLocalNotice("Creating a new session...");
				await onCreateSession();
				setLocalNotice("New session created.");
				return true;
			case "cancel":
				if (isStreaming) {
					await onCancel();
					setLocalNotice("Cancelled active run.");
				} else {
					setLocalNotice("No active run to cancel.");
				}
				return true;
			case "clear":
				onClearMessages();
				setLocalNotice("Cleared local message view.");
				return true;
			case "help":
				setLocalNotice("Commands: /new, /cancel, /clear, /help");
				return true;
			default:
				return false;
		}
	};

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		const text = input.trim();
		if (!text) return;
		if (text.startsWith("/")) {
			runCommand(text).then((handled) => {
				if (!handled) {
					setLocalNotice(`Unknown command: ${text}`);
				}
			});
			setInput("");
			return;
		}
		if (!canSubmit) return;
		commitSend(text);
	};

	const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			const text = input.trim();
			if (text.startsWith("/")) {
				runCommand(text).then((handled) => {
					if (!handled) {
						setLocalNotice(`Unknown command: ${text}`);
					}
				});
				setInput("");
				return;
			}
			if (canSubmit) {
				commitSend(text);
			}
		}
	};

	const sendPrompt = (text: string) => {
		if (!sessionId || isStreaming) return;
		commitSend(text);
	};

	const handleCreateFromEmpty = async () => {
		setBusyCreating(true);
		try {
			await onCreateSession();
		} finally {
			setBusyCreating(false);
		}
	};

	if (!sessionId) {
		return (
			<section className="az-chat-panel">
				<header className="az-chat-head">
					<div>
						<p className="az-overline">Workspace</p>
						<h2 className="az-chat-title">No Session Selected</h2>
					</div>
					<button
						type="button"
						className="az-btn az-btn-muted az-mobile-menu-btn"
						onClick={onOpenSidebar}
					>
						Sessions
					</button>
				</header>

				<div className="az-empty-state az-empty-state-main">
					<h2>Pick a session, then run the agent.</h2>
					<p>
						Use Session Dock to resume prior chats, or create a new one for a
						focused thread.
					</p>
					<div className="az-empty-actions">
						<button
							type="button"
							className="az-btn az-btn-solid"
							onClick={handleCreateFromEmpty}
							disabled={busyCreating}
						>
							{busyCreating ? "Creating..." : "Create Session"}
						</button>
						<button
							type="button"
							className="az-btn az-btn-muted"
							onClick={onOpenSidebar}
						>
							Open Session Dock
						</button>
					</div>
				</div>
			</section>
		);
	}

	return (
		<section className="az-chat-panel">
			<header className="az-chat-head">
				<div className="az-chat-head-main">
					<button
						type="button"
						className="az-btn az-btn-muted az-mobile-menu-btn"
						onClick={onOpenSidebar}
					>
						Sessions
					</button>
					<div>
						<p className="az-overline">Conversation</p>
						<h2 className="az-chat-title">{sessionId}</h2>
						<p className="az-chat-hint">{formatHint(sessionId)}</p>
					</div>
				</div>
				<div className={`az-stream-pill is-${streamPhase}`}>
					<span className="az-stream-dot" />
					<div>
						<div className="az-stream-label">{phase.label}</div>
						<div className="az-stream-detail">{phase.detail}</div>
					</div>
				</div>
			</header>

			{lastError ? <div className="az-error-banner">{lastError}</div> : null}
			{localNotice ? (
				<div className="az-notice-banner">{localNotice}</div>
			) : null}
			<div className="az-status-strip">
				<span>{messages.length} messages</span>
				<span>
					{runStartedAt
						? `running for ${Math.max(1, Math.floor((Date.now() - runStartedAt) / 1000))}s`
						: "run idle"}
				</span>
				<span>
					{lastRunDurationMs !== null
						? `last run ${Math.round(lastRunDurationMs / 100) / 10}s`
						: "no completed run yet"}
				</span>
			</div>

			<div className="az-messages" aria-live="polite">
				{messages.length === 0 ? (
					<div className="az-empty-hint az-empty-chat">
						<p>Start with one of these prompts.</p>
						<div className="az-chip-row">
							{QUICK_PROMPTS.map((prompt) => (
								<button
									key={prompt}
									type="button"
									className="az-chip"
									onClick={() => sendPrompt(prompt)}
									disabled={isStreaming}
								>
									{prompt}
								</button>
							))}
						</div>
					</div>
				) : null}
				{messages.map((msg) => (
					<MessageBubble key={msg.id} message={msg} />
				))}
				<div ref={bottomRef} />
			</div>

			<form onSubmit={handleSubmit} className="az-input-wrap">
				<div className="az-input-stack">
					<textarea
						ref={textareaRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleComposerKeyDown}
						placeholder="Ask for implementation ideas, code edits, reviews, or debugging steps"
						disabled={isStreaming}
						rows={1}
						className="az-input"
					/>
					<div className="az-input-footnote">
						<span>Enter to send, Shift+Enter for newline</span>
						<span>/help for commands</span>
						<span>{input.length} chars</span>
					</div>
				</div>
				{isStreaming ? (
					<button
						type="button"
						onClick={onCancel}
						className="az-btn az-btn-danger"
					>
						Stop
					</button>
				) : (
					<button
						type="submit"
						disabled={!canSubmit}
						className="az-btn az-btn-accent"
					>
						Send
					</button>
				)}
			</form>
		</section>
	);
};
