import type { DesktopSession, DesktopWorkspace } from "../../shared/types";
import { LandingEmptyView } from "./landing/LandingEmptyView";
import { LandingWorkspaceView } from "./landing/LandingWorkspaceView";

export const LandingView = ({
	workspace,
	sessions,
	runtimeConnected,
	runtimeModelLabel,
	onOpenWorkspace,
	onNewChat,
	onLoadInspect,
	onLoadSession,
}: {
	workspace?: DesktopWorkspace;
	sessions: DesktopSession[];
	runtimeConnected: boolean;
	runtimeModelLabel: string;
	onOpenWorkspace: () => Promise<void>;
	onNewChat: () => Promise<void>;
	onLoadInspect: () => Promise<void>;
	onLoadSession: (sessionId: string | null) => Promise<void>;
}) => {
	const runtimeLabel = runtimeConnected ? "Connected" : "Offline";

	if (!workspace) {
		return (
			<LandingEmptyView
				runtimeLabel={runtimeLabel}
				modelLabel={runtimeModelLabel}
				onOpenWorkspace={onOpenWorkspace}
			/>
		);
	}

	return (
		<LandingWorkspaceView
			workspace={workspace}
			sessions={sessions}
			runtimeLabel={runtimeLabel}
			modelLabel={runtimeModelLabel}
			onNewChat={onNewChat}
			onLoadInspect={onLoadInspect}
			onLoadSession={onLoadSession}
		/>
	);
};
