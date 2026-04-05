import { useDesktopStore } from "../state/desktop-store";
import { selectSelectedWorkspace } from "../state/selectors";

export const useComposerState = () => {
	const workspace = useDesktopStore(selectSelectedWorkspace);
	const statusLine = useDesktopStore((state) => state.statusLine);
	const errorMessage = useDesktopStore((state) => state.errorMessage);
	const composer = useDesktopStore((state) => state.composer);
	const selectedWorkspacePath = useDesktopStore(
		(state) => state.snapshot.selected_workspace_path,
	);
	const pendingUiRequest = useDesktopStore((state) =>
		Boolean(state.pendingUiRequest),
	);
	const isStreaming = useDesktopStore((state) => state.isStreaming);
	const model = useDesktopStore(
		(state) => state.snapshot.runtime_health?.model,
	);

	return {
		workspace,
		statusLine,
		errorMessage,
		composer,
		selectedWorkspacePath,
		pendingUiRequest,
		isStreaming,
		model,
	};
};
