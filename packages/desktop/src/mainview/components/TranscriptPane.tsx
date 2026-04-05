import { useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { DesktopWorkspace } from "../../shared/types";
import type { AssistantRenderRow, ViewState } from "../controller";
import { buildAssistantRenderRows } from "../controller";
import { GeneratedUiPanel } from "./GeneratedUiPanel";
import { LandingView } from "./LandingView";

const DISCLOSURE_ANIMATION = {
	duration: 240,
	easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];

const animateDisclosureBody = (
	element: HTMLElement,
	direction: "open" | "close",
	onFinish?: () => void,
) => {
	const targetHeight = element.scrollHeight;
	if (targetHeight <= 0) {
		onFinish?.();
		return;
	}
	element.getAnimations().forEach((animation) => animation.cancel());
	element.style.overflow = "hidden";
	const frames =
		direction === "open"
			? [
					{
						opacity: 0.42,
						transform: "translateY(-3px)",
						height: "0px",
					},
					{
						opacity: 1,
						transform: "translateY(0)",
						height: `${targetHeight}px`,
					},
				]
			: [
					{
						opacity: 1,
						transform: "translateY(0)",
						height: `${targetHeight}px`,
					},
					{
						opacity: 0.42,
						transform: "translateY(-3px)",
						height: "0px",
					},
				];
	const cleanup = () => {
		element.style.overflow = "";
		onFinish?.();
	};
	const animation = element.animate(frames, DISCLOSURE_ANIMATION);
	animation.addEventListener("finish", cleanup, { once: true });
	animation.addEventListener("cancel", cleanup, { once: true });
};

const AssistantMarkdown = ({
	content,
	finalized,
	onOpenLink,
}: {
	content: string;
	finalized: boolean;
	onOpenLink: (href: string) => Promise<void>;
}) => {
	return (
		<div className={`assistant-copy${finalized ? "" : " is-streaming"}`}>
			<div className="assistant-copy-body markdown-body">
				<ReactMarkdown
					remarkPlugins={MARKDOWN_REMARK_PLUGINS}
					skipHtml
					components={{
						a: ({ node: _node, ...props }) => {
							const href = props.href;
							return (
								<a
									{...props}
									onClick={(event) => {
										event.preventDefault();
										if (typeof href === "string") {
											void onOpenLink(href);
										}
									}}
								/>
							);
						},
						code: ({ className, children, ...props }) => {
							const hasLanguage =
								typeof className === "string" &&
								className.includes("language-");
							if (hasLanguage) {
								return (
									<code className={className} {...props}>
										{children}
									</code>
								);
							}
							return (
								<code className="markdown-inline-code" {...props}>
									{children}
								</code>
							);
						},
						pre: ({ node: _node, ...props }) => (
							<pre className="markdown-code-block" {...props} />
						),
					}}
				>
					{content}
				</ReactMarkdown>
			</div>
		</div>
	);
};

const AssistantTurn = ({
	rows,
	onOpenLink,
}: {
	rows: AssistantRenderRow[];
	onOpenLink: (href: string) => Promise<void>;
}) => {
	return (
		<article className="assistant-turn">
			<div className="assistant-heading">
				<strong className="bubble-author">Codelia</strong>
			</div>
			<div className="timeline-stack">
				{rows.map((row) =>
					row.kind === "html" ? (
						<div key={row.key} dangerouslySetInnerHTML={{ __html: row.html }} />
					) : row.kind === "generated_ui" ? (
						<GeneratedUiPanel key={row.key} payload={row.payload} />
					) : (
						<AssistantMarkdown
							key={row.key}
							content={row.content}
							finalized={row.finalized}
							onOpenLink={onOpenLink}
						/>
					),
				)}
			</div>
		</article>
	);
};

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
			if (state.isStreaming && index === lastAssistantIndex) {
				return [
					{
						kind: "html" as const,
						key: `${message.id}-pending`,
						html: '<div class="assistant-pending">Running...</div>',
					},
				];
			}
			return [];
		});
	}, [state.isStreaming, state.snapshot.transcript]);

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
		<section
			ref={transcriptRef}
			className={`transcript${
				state.snapshot.transcript.length > 0 ? " has-messages" : ""
			}`}
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
					</div>
				)}
			</div>
		</section>
	);
};
