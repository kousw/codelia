import { useState } from "react";
import { DEFAULT_VISIBLE_THREAD_COUNT } from "../../../shared/layout";
import type { DesktopSession } from "../../../shared/types";
import { formatRelativeTime } from "../../controller";
import { EyeOff, MessageSquare, Pencil, uiIconProps } from "../../icons";

export const SessionsList = ({
	sessions,
	selectedSessionId,
	onLoadSession,
	onRenameSession,
	onHideSession,
}: {
	sessions: DesktopSession[];
	selectedSessionId?: string;
	onLoadSession: (sessionId: string | null) => Promise<void>;
	onRenameSession: (sessionId: string) => Promise<void>;
	onHideSession: (sessionId: string) => void;
}) => {
	const [expanded, setExpanded] = useState(false);

	if (sessions.length === 0) {
		return (
			<div className="section-empty compact">
				<MessageSquare {...uiIconProps} className="section-empty-icon" />
				<strong>No sessions yet</strong>
				<span className="muted">Start the first thread in this workspace.</span>
			</div>
		);
	}

	const visibleSessions = expanded
		? sessions
		: sessions.slice(0, DEFAULT_VISIBLE_THREAD_COUNT);
	const hiddenCount = Math.max(0, sessions.length - visibleSessions.length);

	return (
		<>
			{visibleSessions.map((session) => (
				<div
					key={session.session_id}
					className={`session-row${
						selectedSessionId === session.session_id ? " is-active" : ""
					}`}
				>
					<button
						type="button"
						className="session-main"
						title={session.last_user_message ?? session.title}
						onClick={() => void onLoadSession(session.session_id)}
					>
						<div className="session-line">
							<span className="session-title">{session.title}</span>
							<small className="session-time">
								{formatRelativeTime(session.updated_at)}
							</small>
						</div>
					</button>
					<div className="session-actions electrobun-webkit-app-region-no-drag">
						<button
							type="button"
							className="button button-subtle has-icon"
							title={`Rename ${session.title}`}
							onClick={() => void onRenameSession(session.session_id)}
						>
							<Pencil {...uiIconProps} className="button-icon" />
							<span>Rename</span>
						</button>
						<button
							type="button"
							className="button button-subtle has-icon"
							title={`Hide ${session.title}`}
							onClick={() => onHideSession(session.session_id)}
						>
							<EyeOff {...uiIconProps} className="button-icon" />
							<span>Hide</span>
						</button>
					</div>
				</div>
			))}
			{sessions.length > DEFAULT_VISIBLE_THREAD_COUNT ? (
				<button
					type="button"
					className="session-list-toggle button button-subtle"
					aria-expanded={expanded}
					onClick={() => setExpanded((current) => !current)}
				>
					<span>{expanded ? "Less" : `More ${hiddenCount}`}</span>
				</button>
			) : null}
		</>
	);
};
