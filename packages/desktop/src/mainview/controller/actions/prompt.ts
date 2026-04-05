import {
	appendErrorMessage,
	attachStartedRun,
	beginPromptRun,
	revertPromptRunStart,
} from "../../state/actions";
import { getDesktopViewState } from "../../state/desktop-store";
import { rpc } from "../runtime";

export const sendPrompt = async (): Promise<void> => {
	const currentState = getDesktopViewState();
	const workspacePath = currentState.snapshot.selected_workspace_path;
	const message = currentState.composer.trim();
	if (!workspacePath || message.length === 0 || currentState.isStreaming) {
		return;
	}

	beginPromptRun(message);

	try {
		const started = await rpc.request.startRun({
			workspace_path: workspacePath,
			session_id: currentState.snapshot.selected_session_id,
			message,
		});
		attachStartedRun(started);
	} catch (error) {
		revertPromptRunStart(error);
	}
};

export const cancelRun = async (): Promise<void> => {
	const currentState = getDesktopViewState();
	if (!currentState.activeRunId) return;
	await rpc.request.cancelRun({ run_id: currentState.activeRunId });
};

export const openTranscriptLink = async (href: string): Promise<void> => {
	const result = await rpc.request.openLink({
		href,
		workspace_path: getDesktopViewState().snapshot.selected_workspace_path,
	});
	if (!result.ok) {
		appendErrorMessage(result.message ?? "Failed to open link");
	}
};
