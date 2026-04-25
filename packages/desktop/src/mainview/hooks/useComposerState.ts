import { useDesktopStore } from "../state/desktop-store";

export const useComposerState = () => {
	const statusLine = useDesktopStore((state) => state.statusLine);
	const composerNotice = useDesktopStore((state) => state.composerNotice);
	const errorMessage = useDesktopStore((state) => state.errorMessage);
	const composer = useDesktopStore((state) => state.composer);
	const pendingShellResultCount = useDesktopStore(
		(state) => state.pendingShellResults.length,
	);
	const selectedWorkspacePath = useDesktopStore(
		(state) => state.snapshot.selected_workspace_path,
	);
	const pendingUiRequest = useDesktopStore((state) =>
		Boolean(state.pendingUiRequest),
	);
	const isStreaming = useDesktopStore((state) => state.isStreaming);
	const isShellRunning = useDesktopStore((state) => state.isShellRunning);
	const contextLeftPercent = useDesktopStore(
		(state) => state.contextLeftPercent,
	);
	const model = useDesktopStore(
		(state) => state.snapshot.runtime_health?.model,
	);
	const gitBranch = useDesktopStore(
		(state) => state.snapshot.runtime_health?.branch,
	);
	const gitBranches = useDesktopStore(
		(state) => state.snapshot.runtime_health?.branches,
	);
	const gitIsDirty = useDesktopStore(
		(state) => state.snapshot.runtime_health?.is_dirty,
	);

	return {
		statusLine,
		composerNotice,
		errorMessage,
		composer,
		pendingShellResultCount,
		selectedWorkspacePath,
		pendingUiRequest,
		isStreaming,
		isShellRunning,
		contextLeftPercent,
		model,
		git: {
			branch: gitBranch,
			branches: gitBranches ?? [],
			isDirty: gitIsDirty,
		},
	};
};
