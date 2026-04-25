import type { DesktopSession, DesktopWorkspace } from "../../shared/types";
import { FolderGit2, FolderSearch, SquarePen, uiIconProps } from "../icons";
import { SessionsList } from "./sidebar/SessionsList";

export const WorkspaceSidebar = ({
	workspaces,
	selectedWorkspacePath,
	sessions,
	selectedSessionId,
	onNewChatForWorkspace,
	onLoadSession,
	onRenameSession,
	onHideSession,
}: {
	workspaces: DesktopWorkspace[];
	selectedWorkspacePath?: string;
	sessions: DesktopSession[];
	selectedSessionId?: string;
	onNewChatForWorkspace: (workspacePath: string) => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
	onRenameSession: (sessionId: string) => Promise<void>;
	onHideSession: (sessionId: string) => void;
}) => {
	if (workspaces.length === 0) {
		return (
			<div className="section-empty">
				<FolderSearch {...uiIconProps} className="section-empty-icon" />
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
				const workspaceSessions = sessions.filter(
					(session) => session.workspace_path === workspace.path,
				);
				return (
					<section
						key={workspace.path}
						className={`workspace-group${isActive ? " is-active" : ""}`}
					>
						<div
							className={`workspace-button${isActive ? " is-active" : ""}`}
							title={workspace.path}
						>
							<div className="workspace-line">
								<span className="workspace-title-row">
									<FolderGit2 {...uiIconProps} className="workspace-row-icon" />
									<strong className="workspace-title">{workspace.name}</strong>
								</span>
								{workspace.invalid ? (
									<small className="workspace-status">Missing</small>
								) : (
									<button
										type="button"
										className="button button-subtle has-icon workspace-new-chat-button"
										title={`New chat in ${workspace.name}`}
										onClick={() => void onNewChatForWorkspace(workspace.path)}
									>
										<SquarePen {...uiIconProps} className="button-icon" />
										<span>New Chat</span>
									</button>
								)}
							</div>
						</div>
						{workspaceSessions.length > 0 ? (
							<div className="workspace-children">
								<div className="session-list">
									<SessionsList
										sessions={workspaceSessions}
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
