import type { DesktopSession, DesktopWorkspace } from "../../shared/types";
import { formatRelativeTime } from "../controller";

const SessionsList = ({
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
	if (sessions.length === 0) {
		return (
			<div className="section-empty compact">
				<strong>No sessions yet</strong>
				<span className="muted">Start the first thread in this workspace.</span>
			</div>
		);
	}

	return (
		<>
			{sessions.map((session) => (
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
							<strong className="session-title">{session.title}</strong>
							<small className="session-time">
								{formatRelativeTime(session.updated_at)}
							</small>
						</div>
					</button>
					<div className="session-actions electrobun-webkit-app-region-no-drag">
						<button
							type="button"
							className="button button-subtle"
							title={`Rename ${session.title}`}
							onClick={() => void onRenameSession(session.session_id)}
						>
							Rename
						</button>
						<button
							type="button"
							className="button button-subtle"
							title={`Hide ${session.title}`}
							onClick={() => onHideSession(session.session_id)}
						>
							Hide
						</button>
					</div>
				</div>
			))}
		</>
	);
};

export const WorkspaceSidebar = ({
	workspaces,
	selectedWorkspacePath,
	sessions,
	selectedSessionId,
	onLoadWorkspace,
	onLoadSession,
	onRenameSession,
	onHideSession,
}: {
	workspaces: DesktopWorkspace[];
	selectedWorkspacePath?: string;
	sessions: DesktopSession[];
	selectedSessionId?: string;
	onLoadWorkspace: (workspacePath: string) => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
	onRenameSession: (sessionId: string) => Promise<void>;
	onHideSession: (sessionId: string) => void;
}) => {
	if (workspaces.length === 0) {
		return (
			<div className="section-empty">
				<strong>No workspace yet</strong>
				<span className="muted">
					Open a folder from the native dialog to get started.
				</span>
			</div>
		);
	}

	return (
		<>
			{workspaces.map((workspace) => {
				const isActive = selectedWorkspacePath === workspace.path;
				return (
					<section
						key={workspace.path}
						className={`workspace-group${isActive ? " is-active" : ""}`}
					>
						<button
							type="button"
							className={`workspace-button${isActive ? " is-active" : ""}`}
							title={workspace.path}
							onClick={() => void onLoadWorkspace(workspace.path)}
						>
							<div className="workspace-line">
								<strong className="workspace-title">{workspace.name}</strong>
								<small className="workspace-status">
									{workspace.invalid
										? "Missing"
										: `${workspace.branch ?? "no-git"}${
												workspace.is_dirty ? " • dirty" : ""
											}`}
								</small>
							</div>
						</button>
						{isActive ? (
							<div className="workspace-children">
								<div className="section-heading compact threads-heading">
									<p className="eyebrow">Threads</p>
									<div className="thread-actions electrobun-webkit-app-region-no-drag">
										<button
											type="button"
											className="button button-subtle sidebar-compact-action"
											onClick={() => void onLoadSession(null)}
										>
											New Chat
										</button>
									</div>
								</div>
								<div className="session-list">
									<SessionsList
										sessions={sessions}
										selectedSessionId={selectedSessionId}
										onLoadSession={onLoadSession}
										onRenameSession={onRenameSession}
										onHideSession={onHideSession}
									/>
								</div>
							</div>
						) : null}
					</section>
				);
			})}
		</>
	);
};
