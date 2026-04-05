import { useEffect } from "react";
import { ModalLayer } from "./components/ModalLayer";
import { AppSidebar } from "./components/shell/AppSidebar";
import { Composer } from "./components/shell/Composer";
import { InspectRail } from "./components/shell/InspectRail";
import { WorkspaceTopbar } from "./components/shell/WorkspaceTopbar";
import { TranscriptPane } from "./components/transcript/TranscriptPane";
import {
	cancelRun,
	commitState,
	initializeView,
	loadInspect,
	loadSession,
	loadWorkspace,
	openWorkspaceForNewChat,
	openTranscriptLink,
	openWorkspaceTarget,
	openWorkspaceDialog,
	refreshInspect,
	renameSession,
	requestHideSession,
	resolveModalDismissPayload,
	selectedWorkspace,
	sendPrompt,
	submitModal,
	updateModel,
	updateModelReasoning,
} from "./controller";
import { useDesktopViewState } from "./hooks/useDesktopViewState";

export const App = () => {
	const state = useDesktopViewState();
	const workspace = selectedWorkspace(state.snapshot);

	useEffect(() => {
		document.body.dataset.platform = /Mac|iPhone|iPad/.test(navigator.platform)
			? "mac"
			: "other";
		void initializeView();
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") {
				return;
			}
			const request = state.pendingUiRequest;
			if (request) {
				event.preventDefault();
				void submitModal(resolveModalDismissPayload(request));
				return;
			}
			if (state.pendingLocalDialog) {
				event.preventDefault();
				commitState((draft) => {
					draft.pendingLocalDialog = null;
				});
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [state.pendingLocalDialog, state.pendingUiRequest]);

	return (
		<>
			<div className={`shell${state.inspectOpen ? " is-inspect-open" : ""}`}>
				<AppSidebar
					workspaces={state.snapshot.workspaces}
					selectedWorkspacePath={state.snapshot.selected_workspace_path}
					sessions={state.snapshot.sessions}
					selectedSessionId={state.snapshot.selected_session_id}
					onNewChat={() => loadSession(null)}
					onAddWorkspace={openWorkspaceForNewChat}
					onLoadWorkspace={loadWorkspace}
					onLoadSession={loadSession}
					onRenameSession={renameSession}
					onHideSession={requestHideSession}
				/>

				<main className="panel center">
					<WorkspaceTopbar
						workspace={workspace}
						runtimeConnected={Boolean(state.snapshot.runtime_health?.connected)}
						inspectOpen={state.inspectOpen}
						onToggleInspect={loadInspect}
						onOpenWorkspaceTarget={openWorkspaceTarget}
						onChooseWorkspace={openWorkspaceDialog}
					/>

					<TranscriptPane
						state={state}
						workspace={workspace}
						onOpenWorkspace={openWorkspaceDialog}
						onNewChat={() => loadSession(null)}
						onLoadInspect={loadInspect}
						onLoadSession={loadSession}
						onCopySection={(text) => {
							void navigator.clipboard.writeText(text).catch((error) => {
								commitState((draft) => {
									draft.errorMessage = String(error);
								});
							});
						}}
						onOpenLink={openTranscriptLink}
					/>

					<Composer
						workspace={workspace}
						statusLine={state.statusLine}
						errorMessage={state.errorMessage}
						composer={state.composer}
						selectedWorkspacePath={state.snapshot.selected_workspace_path}
						pendingUiRequest={Boolean(state.pendingUiRequest)}
						isStreaming={state.isStreaming}
						model={state.snapshot.runtime_health?.model}
						onComposerChange={(value) =>
							commitState((draft) => {
								draft.composer = value;
							})
						}
						onSend={sendPrompt}
						onCancel={cancelRun}
						onUpdateModel={updateModel}
						onUpdateModelReasoning={updateModelReasoning}
					/>
				</main>

				{state.inspectOpen ? (
					<InspectRail
						inspect={state.inspect}
						onRefresh={refreshInspect}
						onClose={loadInspect}
					/>
				) : null}
			</div>

			<ModalLayer state={state} />
		</>
	);
};
