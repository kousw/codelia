import { applyControlSnapshot } from "../../state/actions";
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
		fast: model.fast ?? false,
	});
	applyControlSnapshot(snapshot, "Model updated");
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
		fast: model.fast ?? false,
	});
	applyControlSnapshot(snapshot, "Reasoning updated");
};

export const updateModelFast = async (fast: boolean): Promise<void> => {
	const currentState = getDesktopViewState();
	const workspacePath = currentState.snapshot.selected_workspace_path;
	const model = currentState.snapshot.runtime_health?.model;
	if (!workspacePath || !model?.current) return;
	const snapshot = await rpc.request.setModel({
		workspace_path: workspacePath,
		name: model.current,
		provider: model.provider,
		reasoning: model.reasoning ?? "medium",
		fast,
	});
	applyControlSnapshot(
		snapshot,
		fast ? "Fast mode enabled" : "Fast mode disabled",
	);
};
