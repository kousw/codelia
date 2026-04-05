import type { DesktopSnapshot, DesktopWorkspace } from "../../shared/types";
import type { ViewState } from "./view-state";

export const selectedWorkspaceFromSnapshot = (
	snapshot: DesktopSnapshot,
): DesktopWorkspace | undefined =>
	snapshot.workspaces.find(
		(workspace) => workspace.path === snapshot.selected_workspace_path,
	);

export const selectSelectedWorkspace = (
	state: ViewState,
): DesktopWorkspace | undefined =>
	selectedWorkspaceFromSnapshot(state.snapshot);

export const selectRuntimeConnected = (state: ViewState): boolean =>
	Boolean(state.snapshot.runtime_health?.connected);

export const selectRuntimeModelLabel = (state: ViewState): string =>
	state.snapshot.runtime_health?.model?.current ??
	state.snapshot.runtime_health?.model?.provider ??
	"Model not loaded";
