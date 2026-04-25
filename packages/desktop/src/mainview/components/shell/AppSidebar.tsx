import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { DesktopSession, DesktopWorkspace } from "../../../shared/types";
import { FolderPlus, PanelLeftClose, Settings, uiIconProps } from "../../icons";
import { WorkspaceSidebar } from "../WorkspaceSidebar";

export const AppSidebar = ({
	workspaces,
	selectedWorkspacePath,
	sessions,
	selectedSessionId,
	sidebarWidth,
	isResizing,
	isCollapsed,
	onAddWorkspace,
	onNewChatForWorkspace,
	onLoadSession,
	onRenameSession,
	onHideSession,
	onCollapse,
	onStartResize,
}: {
	workspaces: DesktopWorkspace[];
	selectedWorkspacePath?: string;
	sessions: DesktopSession[];
	selectedSessionId?: string;
	sidebarWidth: number;
	isResizing: boolean;
	isCollapsed: boolean;
	onAddWorkspace: () => Promise<void>;
	onNewChatForWorkspace: (workspacePath: string) => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
	onRenameSession: (sessionId: string) => Promise<void>;
	onHideSession: (sessionId: string) => void;
	onCollapse: () => void;
	onStartResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) => {
	const sidebarStyle = {
		"--sidebar-width": `${sidebarWidth}px`,
	} as CSSProperties;

	return (
		<aside
			className={`panel sidebar${isResizing ? " is-resizing" : ""}${
				isCollapsed ? " is-collapsed" : ""
			}`}
			style={sidebarStyle}
			aria-hidden={isCollapsed}
			inert={isCollapsed}
		>
			<div className="sidebar-brandbar electrobun-webkit-app-region-drag">
				<button
					type="button"
					className="button button-subtle icon-button sidebar-collapse-button electrobun-webkit-app-region-no-drag"
					aria-label="Collapse sidebar"
					title="Collapse sidebar"
					onClick={onCollapse}
				>
					<PanelLeftClose {...uiIconProps} className="button-icon" />
				</button>
			</div>
			<div className="sidebar-workspacebar electrobun-webkit-app-region-no-drag">
				<p className="sidebar-nav-heading">Projects</p>
				<div className="sidebar-actions">
					<button
						type="button"
						className="button button-subtle icon-button"
						aria-label="Add project"
						title="Add project"
						onClick={() => void onAddWorkspace()}
					>
						<FolderPlus {...uiIconProps} className="button-icon" />
					</button>
				</div>
			</div>
			<section className="sidebar-section">
				<div className="workspace-list grouped">
					<WorkspaceSidebar
						workspaces={workspaces}
						selectedWorkspacePath={selectedWorkspacePath}
						sessions={sessions}
						selectedSessionId={selectedSessionId}
						onNewChatForWorkspace={onNewChatForWorkspace}
						onLoadSession={onLoadSession}
						onRenameSession={onRenameSession}
						onHideSession={onHideSession}
					/>
				</div>
			</section>
			<div className="sidebar-footer electrobun-webkit-app-region-no-drag">
				<button
					type="button"
					className="settings-button button button-subtle has-icon"
					disabled
					title="Settings"
				>
					<Settings {...uiIconProps} className="button-icon" />
					<span>Settings</span>
				</button>
			</div>
			<button
				type="button"
				className="sidebar-resize-handle electrobun-webkit-app-region-no-drag"
				aria-label="Resize sidebar"
				onPointerDown={onStartResize}
			/>
		</aside>
	);
};
