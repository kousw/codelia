import type { DesktopSession, DesktopWorkspace } from "../../shared/types";
import {
	FolderGit2,
	FolderSearch,
	GitBranch,
	SquarePen,
	uiIconProps,
} from "../icons";
import { SessionsList } from "./sidebar/SessionsList";

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
								<span className="workspace-title-row">
									<FolderGit2 {...uiIconProps} className="workspace-row-icon" />
									<strong className="workspace-title">{workspace.name}</strong>
								</span>
								<small className="workspace-status">
									{workspace.invalid ? null : (
										<GitBranch {...uiIconProps} className="status-icon" />
									)}
									<span>
										{workspace.invalid
											? "Missing"
											: `${workspace.branch ?? "no-git"}${
													workspace.is_dirty ? " • dirty" : ""
												}`}
									</span>
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
											className="button button-subtle sidebar-compact-action has-icon"
											onClick={() => void onLoadSession(null)}
										>
											<SquarePen {...uiIconProps} className="button-icon" />
											<span>New Chat</span>
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
