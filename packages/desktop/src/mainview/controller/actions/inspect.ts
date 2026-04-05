import { applyInspectBundle, setInspectOpen } from "../../state/actions";
import { getDesktopViewState } from "../../state/desktop-store";
import { rpc } from "../runtime";

export const loadInspect = async (): Promise<void> => {
	const workspacePath = getDesktopViewState().snapshot.selected_workspace_path;
	if (!workspacePath) return;
	if (getDesktopViewState().inspectOpen) {
		setInspectOpen(false);
		return;
	}
	setInspectOpen(true);
	const inspect = await rpc.request.getInspect({
		workspace_path: workspacePath,
	});
	applyInspectBundle(inspect);
};

export const refreshInspect = async (): Promise<void> => {
	const workspacePath = getDesktopViewState().snapshot.selected_workspace_path;
	if (!workspacePath) return;
	const inspect = await rpc.request.getInspect({
		workspace_path: workspacePath,
	});
	applyInspectBundle(inspect);
};
