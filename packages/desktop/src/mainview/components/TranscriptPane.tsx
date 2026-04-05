import { useEffect, useRef } from "react";
import type { DesktopWorkspace } from "../../shared/types";
import type { ViewState } from "../controller";
import { renderTranscriptHtml } from "../controller";
import { LandingView } from "./LandingView";

const DISCLOSURE_ANIMATION = {
	duration: 240,
	easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

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

export const TranscriptPane = ({
	state,
	workspace,
	onOpenWorkspace,
	onNewChat,
	onLoadInspect,
	onLoadSession,
	onCopySection,
}: {
	state: ViewState;
	workspace?: DesktopWorkspace;
	onOpenWorkspace: () => Promise<void>;
	onNewChat: () => Promise<void>;
	onLoadInspect: () => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
	onCopySection: (text: string) => void;
}) => {
	const transcriptHtml =
		state.snapshot.transcript.length > 0 ? renderTranscriptHtml(state) : null;
	const transcriptRef = useRef<HTMLElement | null>(null);

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
	}, [transcriptHtml]);

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
					<div dangerouslySetInnerHTML={{ __html: transcriptHtml ?? "" }} />
				)}
			</div>
		</section>
	);
};
