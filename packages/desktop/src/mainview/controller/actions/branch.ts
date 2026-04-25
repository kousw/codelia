import { applyControlSnapshot, setErrorMessage } from "../../state/actions";
import { getDesktopViewState } from "../../state/desktop-store";
import { rpc } from "../runtime";

export const switchBranch = async (branch: string): Promise<void> => {
	const currentState = getDesktopViewState();
	const workspacePath = currentState.snapshot.selected_workspace_path;
	const currentBranch = currentState.snapshot.runtime_health?.branch;
	if (!workspacePath || !branch || branch === currentBranch) return;
	try {
		const snapshot = await rpc.request.switchBranch({
			workspace_path: workspacePath,
			branch,
		});
		applyControlSnapshot(snapshot, `Switched to ${branch}`);
	} catch (error) {
		setErrorMessage(error instanceof Error ? error.message : String(error));
	}
};
