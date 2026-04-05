import {
	applyHiddenSession,
	applySessionLoaded,
	applySessionRenamed,
	showPendingHideSessionDialog,
} from "../../state/actions";
import { getDesktopViewState } from "../../state/desktop-store";
import { rpc } from "../runtime";

export const loadSession = async (sessionId: string | null): Promise<void> => {
	const workspacePath = getDesktopViewState().snapshot.selected_workspace_path;
	if (!workspacePath) return;
	const snapshot = await rpc.request.loadSession({
		workspace_path: workspacePath,
		session_id: sessionId,
	});
	applySessionLoaded(snapshot, sessionId);
};

export const renameSession = async (sessionId: string): Promise<void> => {
	const session = getDesktopViewState().snapshot.sessions.find(
		(entry) => entry.session_id === sessionId,
	);
	const workspacePath = getDesktopViewState().snapshot.selected_workspace_path;
	if (!session || !workspacePath) return;
	const nextTitle = window.prompt("Session title", session.title);
	if (nextTitle === null) return;
	const snapshot = await rpc.request.updateSession({
		session_id: sessionId,
		workspace_path: workspacePath,
		title: nextTitle,
	});
	applySessionRenamed(snapshot);
};

export const requestHideSession = (sessionId: string): void => {
	if (getDesktopViewState().pendingUiRequest) return;
	const session = getDesktopViewState().snapshot.sessions.find(
		(entry) => entry.session_id === sessionId,
	);
	if (!session) return;
	showPendingHideSessionDialog(sessionId, session.title);
};

export const hideSession = async (sessionId: string): Promise<void> => {
	const workspacePath = getDesktopViewState().snapshot.selected_workspace_path;
	if (!workspacePath) return;
	const snapshot = await rpc.request.updateSession({
		session_id: sessionId,
		workspace_path: workspacePath,
		archived: true,
	});
	applyHiddenSession(snapshot);
};
