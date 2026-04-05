import { useDesktopStore } from "../state/desktop-store";
import {
	selectRuntimeConnected,
	selectRuntimeModelLabel,
	selectSelectedWorkspace,
} from "../state/selectors";

export const useTranscriptState = () => {
	const transcript = useDesktopStore((state) => state.snapshot.transcript);
	const sessions = useDesktopStore((state) => state.snapshot.sessions);
	const isStreaming = useDesktopStore((state) => state.isStreaming);
	const workspace = useDesktopStore(selectSelectedWorkspace);
	const runtimeConnected = useDesktopStore(selectRuntimeConnected);
	const runtimeModelLabel = useDesktopStore(selectRuntimeModelLabel);

	return {
		transcript,
		sessions,
		isStreaming,
		workspace,
		runtimeConnected,
		runtimeModelLabel,
	};
};
