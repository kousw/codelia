import type { DesktopWorkspace } from "../../shared/types";
import type { ViewState } from "../controller";
import { LandingEmptyState } from "./landing/LandingEmptyState";
import { LandingWorkspaceState } from "./landing/LandingWorkspaceState";

export const LandingView = ({
	state,
	workspace,
	onOpenWorkspace,
	onNewChat,
	onLoadInspect,
	onLoadSession,
}: {
	state: ViewState;
	workspace?: DesktopWorkspace;
	onOpenWorkspace: () => Promise<void>;
	onNewChat: () => Promise<void>;
	onLoadInspect: () => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
}) => {
	const runtimeLabel = state.snapshot.runtime_health?.connected
		? "Connected"
		: "Offline";
	const modelLabel =
		state.snapshot.runtime_health?.model?.current ??
		state.snapshot.runtime_health?.model?.provider ??
		"Model not loaded";

	if (!workspace) {
		return (
			<LandingEmptyState
				runtimeLabel={runtimeLabel}
				modelLabel={modelLabel}
				onOpenWorkspace={onOpenWorkspace}
			/>
		);
	}

	return (
		<LandingWorkspaceState
			workspace={workspace}
			sessions={state.snapshot.sessions}
			runtimeLabel={runtimeLabel}
			modelLabel={modelLabel}
			onNewChat={onNewChat}
			onLoadInspect={onLoadInspect}
			onLoadSession={onLoadSession}
		/>
	);
};
