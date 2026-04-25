import { Electroview } from "electrobun/view";
import type { DesktopRpcSchema } from "../../shared/rpc";
import type { DesktopSnapshot, StreamEvent } from "../../shared/types";
import {
	applyAgentRunEvent,
	applyHydratedSnapshot,
	applyMenuAction,
	applyRunContextEvent,
	applyRunStatusEvent,
	applyToastMessage,
	applyUiRequestEvent,
	finishStreamingRun,
} from "../state/actions";
import { getDesktopViewState } from "../state/desktop-store";

const refreshSnapshotForEvent = async (event: StreamEvent): Promise<void> => {
	const selectedSessionId = getDesktopViewState().snapshot.selected_session_id;
	if (
		"session_id" in event &&
		event.session_id &&
		selectedSessionId &&
		event.session_id !== selectedSessionId
	) {
		return;
	}
	const workspacePath =
		"workspace_path" in event && event.workspace_path
			? event.workspace_path
			: getDesktopViewState().snapshot.selected_workspace_path;
	if (!workspacePath) {
		return;
	}
	const snapshot = await rpc.request.loadSession({
		workspace_path: workspacePath,
		session_id:
			"session_id" in event && event.session_id
				? event.session_id
				: (getDesktopViewState().snapshot.selected_session_id ?? null),
	});
	applyHydratedSnapshot(snapshot);
};

const handleRunEvent = async (event: StreamEvent): Promise<void> => {
	if (event.kind === "agent.event") {
		applyAgentRunEvent(event);
		return;
	}

	if (event.kind === "run.status") {
		applyRunStatusEvent(event);
		return;
	}

	if (event.kind === "run.context") {
		applyRunContextEvent(event);
		return;
	}

	if (event.kind === "ui.request") {
		applyUiRequestEvent(event);
		return;
	}

	if (event.kind === "done") {
		finishStreamingRun(event);
		await refreshSnapshotForEvent(event);
	}
};

const handleMenuAction = (payload: {
	snapshot?: DesktopSnapshot;
	action: string;
}): void => {
	applyMenuAction(payload);
};

const handleToast = (payload: { message: string }): void => {
	applyToastMessage(payload.message);
};

export const rpc = Electroview.defineRPC<DesktopRpcSchema>({
	maxRequestTime: 5 * 60 * 1000,
	handlers: {
		messages: {
			runEvent: (event) => {
				void handleRunEvent(event);
			},
			menuAction: handleMenuAction,
			toast: handleToast,
		},
	},
});

new Electroview({ rpc });
