import { applyModelSnapshot } from "../../state/actions";
import { getDesktopViewState } from "../../state/desktop-store";
import { rpc } from "../runtime";

export const updateModel = async (name: string): Promise<void> => {
	const currentState = getDesktopViewState();
	const workspacePath = currentState.snapshot.selected_workspace_path;
	const model = currentState.snapshot.runtime_health?.model;
	if (!workspacePath || !model) return;
	const nextName = name || model.current;
	const nextReasoning = model.reasoning ?? "medium";
	if (!nextName) return;
	const snapshot = await rpc.request.setModel({
		workspace_path: workspacePath,
		name: nextName,
		provider: model.provider,
		reasoning: nextReasoning,
	});
	applyModelSnapshot(snapshot, "Model updated");
};

export const updateModelReasoning = async (
	reasoning: "low" | "medium" | "high" | "xhigh",
): Promise<void> => {
	const currentState = getDesktopViewState();
	const workspacePath = currentState.snapshot.selected_workspace_path;
	const model = currentState.snapshot.runtime_health?.model;
	if (!workspacePath || !model?.current) return;
	const snapshot = await rpc.request.setModel({
		workspace_path: workspacePath,
		name: model.current,
		provider: model.provider,
		reasoning,
	});
	applyModelSnapshot(snapshot, "Reasoning updated");
};
