import { useEffect, useMemo, useRef } from "react";
import type {
	ChatMessage,
	DesktopSession,
	DesktopWorkspace,
} from "../../../shared/types";
import { buildAssistantRenderRows } from "../../controller";
import { LandingView } from "../LandingView";
import { AssistantTurn } from "./AssistantTurn";
import { ConversationRunningIndicator } from "./ConversationRunningIndicator";
import { animateDisclosureBody } from "./disclosure-motion";
import { TranscriptScrollRegion } from "./TranscriptScrollRegion";

export const TranscriptPane = ({
	transcript,
	isStreaming,
	workspace,
	sessions,
	runtimeConnected,
	runtimeModelLabel,
	onOpenWorkspace,
	onNewChat,
	onLoadInspect,
	onLoadSession,
	onCopySection,
	onOpenLink,
}: {
	transcript: ChatMessage[];
	isStreaming: boolean;
	workspace?: DesktopWorkspace;
	sessions: DesktopSession[];
	runtimeConnected: boolean;
	runtimeModelLabel: string;
	onOpenWorkspace: () => Promise<void>;
	onNewChat: () => Promise<void>;
	onLoadInspect: () => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
	onCopySection: (text: string) => void;
	onOpenLink: (href: string) => Promise<void>;
}) => {
	const transcriptRef = useRef<HTMLElement | null>(null);

	const assistantRows = useMemo(() => {
		const lastAssistantIndex = [...transcript]
			.map((message, index) => ({ message, index }))
			.filter(({ message }) => message.role === "assistant")
			.at(-1)?.index;
		return transcript.map((message, index) => {
			if (message.role !== "assistant") {
				return [];
			}
			const rows = buildAssistantRenderRows(message.events);
			if (rows.length > 0) {
				return rows;
			}
			const fallbackResponse = message.content.trim();
			if (fallbackResponse) {
				return [
					{
						kind: "markdown" as const,
						key: `${message.id}-fallback`,
						content: fallbackResponse,
						finalized: !(isStreaming && index === lastAssistantIndex),
					},
				];
			}
			return [];
		});
	}, [isStreaming, transcript]);

	const scrollFollowSignal = useMemo(
		() => ({
			assistantRows,
			isStreaming,
			transcript,
		}),
		[assistantRows, isStreaming, transcript],
	);
	const disclosureBindingSignal = useMemo(
		() =>
			transcript
				.map(
					(message) =>
						`${message.id}:${message.events.length}:${message.content.length}`,
				)
				.join("|"),
		[transcript],
	);

	useEffect(() => {
		void disclosureBindingSignal;
		const root = transcriptRef.current;
		if (!root) return;
		const detailSelectors = "details.timeline-item, details.timeline-subitem";
		const detailsList = Array.from(
			root.querySelectorAll<HTMLDetailsElement>(detailSelectors),
		);
		const cleanups = detailsList.map((details) => {
			const onToggle = () => {
				if (!details.open) return;
				if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
					return;
				}
				const detail = details.querySelector<HTMLElement>(
					":scope > .timeline-detail, :scope > .timeline-subdetail",
				);
				if (!detail) return;
				animateDisclosureBody(detail, "open");
			};
			details.addEventListener("toggle", onToggle);
			return () => details.removeEventListener("toggle", onToggle);
		});
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	}, [disclosureBindingSignal]);

	const handleClick = (event: React.MouseEvent<HTMLElement>) => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;

		const sessionButton = target.closest<HTMLElement>("[data-session-id]");
		if (sessionButton) {
			void onLoadSession(sessionButton.dataset.sessionId ?? "");
			return;
		}

		const copyButton = target.closest<HTMLElement>(
			'[data-action="copy-section"]',
		);
		if (copyButton) {
			const section = copyButton.closest<HTMLElement>(
				".timeline-detail-section",
			);
			const pre = section?.querySelector("pre");
			if (pre) {
				onCopySection(pre.textContent ?? "");
			}
		}
	};

	const handleClickCapture = (event: React.MouseEvent<HTMLElement>) => {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			return;
		}
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const summary = target.closest<HTMLElement>(
			"details.timeline-item > summary, details.timeline-subitem > summary",
		);
		if (!summary) return;
		const details = summary.parentElement;
		if (!(details instanceof HTMLDetailsElement) || !details.open) {
			return;
		}
		event.preventDefault();
		details.dataset.closing = "true";
		const detail = details.querySelector<HTMLElement>(
			":scope > .timeline-detail, :scope > .timeline-subdetail",
		);
		if (!detail) {
			delete details.dataset.closing;
			details.open = false;
			return;
		}
		animateDisclosureBody(detail, "close", () => {
			delete details.dataset.closing;
			details.open = false;
		});
	};

	return (
		<TranscriptScrollRegion
			ref={transcriptRef}
			className={`transcript${transcript.length > 0 ? " has-messages" : ""}`}
			followSignal={scrollFollowSignal}
			onClickCapture={handleClickCapture}
			onClick={handleClick}
		>
			<div
				className={`transcript-stage${transcript.length === 0 ? " is-empty" : ""}`}
			>
				{transcript.length === 0 ? (
					<LandingView
						workspace={workspace}
						sessions={sessions}
						runtimeConnected={runtimeConnected}
						runtimeModelLabel={runtimeModelLabel}
						onOpenWorkspace={onOpenWorkspace}
						onNewChat={onNewChat}
						onLoadInspect={onLoadInspect}
						onLoadSession={onLoadSession}
					/>
				) : (
					<div className="conversation-column">
						{transcript.map((message, index) =>
							message.role === "user" ? (
								<article key={message.id} className="message-row user-row">
									<div className="bubble user">
										<div className="bubble-content">{message.content}</div>
									</div>
								</article>
							) : (
								<AssistantTurn
									key={message.id}
									rows={assistantRows[index] ?? []}
									onOpenLink={onOpenLink}
								/>
							),
						)}
						{isStreaming ? <ConversationRunningIndicator /> : null}
					</div>
				)}
			</div>
		</TranscriptScrollRegion>
	);
};
