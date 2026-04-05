import { useDesktopStore } from "../state/desktop-store";
import {
	selectRuntimeConnected,
	selectSelectedWorkspace,
} from "../state/selectors";

export const useWorkspaceTopbarState = () => {
	const workspace = useDesktopStore(selectSelectedWorkspace);
	const runtimeConnected = useDesktopStore(selectRuntimeConnected);

	return {
		workspace,
		runtimeConnected,
	};
};
