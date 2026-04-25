import {
	appendErrorMessage,
	applyHydratedSnapshot,
	applyWorkspaceOpenError,
	applyWorkspaceOpened,
	applyWorkspaceReady,
} from "../../state/actions";
import { getDesktopViewState } from "../../state/desktop-store";
import { rpc } from "../runtime";

export const openWorkspaceDialog = async (): Promise<void> => {
	try {
		const snapshot = await rpc.request.openWorkspaceDialog();
		applyWorkspaceOpened(snapshot, "Workspace opened");
	} catch (error) {
		applyWorkspaceOpenError(error);
	}
};

export const openWorkspaceForNewChat = async (): Promise<void> => {
	try {
		const openedSnapshot = await rpc.request.openWorkspaceDialog();
		const workspacePath = openedSnapshot.selected_workspace_path;
		if (!workspacePath) {
			applyWorkspaceOpened(openedSnapshot, "Workspace opened");
			return;
		}
		const snapshot = await rpc.request.loadSession({
			workspace_path: workspacePath,
			session_id: null,
		});
		applyWorkspaceOpened(snapshot, "Workspace opened • Draft ready");
	} catch (error) {
		applyWorkspaceOpenError(error);
	}
};

export const loadWorkspace = async (workspacePath: string): Promise<void> => {
	const snapshot = await rpc.request.loadWorkspace({
		workspace_path: workspacePath,
	});
	applyWorkspaceReady(snapshot);
};

export const openWorkspaceTarget = async (
	target: "cursor" | "finder",
): Promise<void> => {
	const workspacePath = getDesktopViewState().snapshot.selected_workspace_path;
	if (!workspacePath) return;
	const result = await rpc.request.openWorkspaceTarget({
		workspace_path: workspacePath,
		target,
	});
	if (!result.ok) {
		appendErrorMessage(result.message ?? "Failed to open workspace");
	}
};

export const updateSidebarWidthPreference = async (
	width: number,
): Promise<void> => {
	const snapshot = await rpc.request.updateUiPreferences({
		sidebar_width: width,
	});
	applyHydratedSnapshot(snapshot);
};
