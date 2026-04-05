import type { DesktopSession, DesktopWorkspace } from "../../../shared/types";
import { FolderPlus, SquarePen, uiIconProps } from "../../icons";
import { WorkspaceSidebar } from "../WorkspaceSidebar";

export const AppSidebar = ({
	workspaces,
	selectedWorkspacePath,
	sessions,
	selectedSessionId,
	onNewChat,
	onAddWorkspace,
	onLoadWorkspace,
	onLoadSession,
	onRenameSession,
	onHideSession,
}: {
	workspaces: DesktopWorkspace[];
	selectedWorkspacePath?: string;
	sessions: DesktopSession[];
	selectedSessionId?: string;
	onNewChat: () => Promise<void>;
	onAddWorkspace: () => Promise<void>;
	onLoadWorkspace: (workspacePath: string) => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
	onRenameSession: (sessionId: string) => Promise<void>;
	onHideSession: (sessionId: string) => void;
}) => {
	return (
		<aside className="panel sidebar">
			<div className="sidebar-header electrobun-webkit-app-region-drag">
				<div className="title-block">
					<p className="eyebrow">Codelia</p>
					<h1>Desktop</h1>
				</div>
				<div className="sidebar-actions electrobun-webkit-app-region-no-drag">
					<button
						type="button"
						className="button has-icon"
						onClick={() => void onNewChat()}
						disabled={!selectedWorkspacePath}
					>
						<SquarePen {...uiIconProps} className="button-icon" />
						<span>New Chat</span>
					</button>
				</div>
			</div>
			<section className="sidebar-section">
				<div className="section-heading">
					<p className="eyebrow">Workspaces</p>
					<div className="section-heading-actions">
						<button
							type="button"
							className="button button-subtle sidebar-compact-action has-icon"
							onClick={() => void onAddWorkspace()}
						>
							<FolderPlus {...uiIconProps} className="button-icon" />
							<span>Add</span>
						</button>
					</div>
				</div>
				<div className="workspace-list grouped">
					<WorkspaceSidebar
						workspaces={workspaces}
						selectedWorkspacePath={selectedWorkspacePath}
						sessions={sessions}
						selectedSessionId={selectedSessionId}
						onLoadWorkspace={onLoadWorkspace}
						onLoadSession={onLoadSession}
						onRenameSession={onRenameSession}
						onHideSession={onHideSession}
					/>
				</div>
			</section>
		</aside>
	);
};
