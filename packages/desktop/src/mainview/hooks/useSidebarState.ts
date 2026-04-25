import { useDesktopStore } from "../state/desktop-store";

export const useSidebarState = () => {
	const workspaces = useDesktopStore((state) => state.snapshot.workspaces);
	const selectedWorkspacePath = useDesktopStore(
		(state) => state.snapshot.selected_workspace_path,
	);
	const sessions = useDesktopStore((state) => state.snapshot.sessions);
	const selectedSessionId = useDesktopStore(
		(state) => state.snapshot.selected_session_id,
	);
	const sidebarWidth = useDesktopStore((state) => state.sidebarWidth);

	return {
		workspaces,
		selectedWorkspacePath,
		sessions,
		selectedSessionId,
		sidebarWidth,
	};
};
