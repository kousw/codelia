import { useEffect, useMemo, useRef } from "react";
import type { DesktopWorkspace } from "../../../shared/types";
import type { ViewState } from "../../controller";
import { buildAssistantRenderRows } from "../../controller";
import { LandingView } from "../LandingView";
import { AssistantTurn } from "./AssistantTurn";
import { ConversationRunningIndicator } from "./ConversationRunningIndicator";
import { animateDisclosureBody } from "./disclosure-motion";
import { TranscriptScrollRegion } from "./TranscriptScrollRegion";

export const TranscriptPane = ({
	state,
	workspace,
	onOpenWorkspace,
	onNewChat,
	onLoadInspect,
	onLoadSession,
	onCopySection,
	onOpenLink,
}: {
	state: ViewState;
	workspace?: DesktopWorkspace;
	onOpenWorkspace: () => Promise<void>;
	onNewChat: () => Promise<void>;
	onLoadInspect: () => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
	onCopySection: (text: string) => void;
	onOpenLink: (href: string) => Promise<void>;
}) => {
	const transcriptRef = useRef<HTMLElement | null>(null);

	const assistantRows = useMemo(() => {
		const lastAssistantIndex = [...state.snapshot.transcript]
			.map((message, index) => ({ message, index }))
			.filter(({ message }) => message.role === "assistant")
			.at(-1)?.index;
		return state.snapshot.transcript.map((message, index) => {
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
						finalized: !(state.isStreaming && index === lastAssistantIndex),
					},
				];
			}
			return [];
		});
	}, [state.isStreaming, state.snapshot.transcript]);

	const scrollFollowSignal = useMemo(
		() => ({
			assistantRows,
			isStreaming: state.isStreaming,
			transcript: state.snapshot.transcript,
		}),
		[assistantRows, state.isStreaming, state.snapshot.transcript],
	);

	useEffect(() => {
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
	}, [assistantRows, state.snapshot.transcript]);

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
			className={`transcript${
				state.snapshot.transcript.length > 0 ? " has-messages" : ""
			}`}
			followSignal={scrollFollowSignal}
			onClickCapture={handleClickCapture}
			onClick={handleClick}
		>
			<div
				className={`transcript-stage${
					state.snapshot.transcript.length === 0 ? " is-empty" : ""
				}`}
			>
				{state.snapshot.transcript.length === 0 ? (
					<LandingView
						state={state}
						workspace={workspace}
						onOpenWorkspace={onOpenWorkspace}
						onNewChat={onNewChat}
						onLoadInspect={onLoadInspect}
						onLoadSession={onLoadSession}
					/>
				) : (
					<div className="conversation-column">
						{state.snapshot.transcript.map((message, index) =>
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
						{state.isStreaming ? <ConversationRunningIndicator /> : null}
					</div>
				)}
			</div>
		</TranscriptScrollRegion>
	);
};
