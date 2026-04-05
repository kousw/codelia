import { useEffect } from "react";
import { ModalLayer } from "./components/ModalLayer";
import { AppSidebar } from "./components/shell/AppSidebar";
import { Composer } from "./components/shell/Composer";
import { InspectRail } from "./components/shell/InspectRail";
import { WorkspaceTopbar } from "./components/shell/WorkspaceTopbar";
import { TranscriptPane } from "./components/transcript/TranscriptPane";
import {
	cancelRun,
	dismissPendingLocalDialog,
	initializeView,
	loadInspect,
	loadSession,
	loadWorkspace,
	openTranscriptLink,
	openWorkspaceDialog,
	openWorkspaceForNewChat,
	openWorkspaceTarget,
	refreshInspect,
	renameSession,
	requestHideSession,
	resolveModalDismissPayload,
	sendPrompt,
	setComposer,
	setErrorMessage,
	setModalText,
	submitModal,
	toggleModalPick,
	updateModel,
	updateModelReasoning,
} from "./controller";
import { useComposerState } from "./hooks/useComposerState";
import { useInspectState } from "./hooks/useInspectState";
import { useModalState } from "./hooks/useModalState";
import { useSidebarState } from "./hooks/useSidebarState";
import { useTranscriptState } from "./hooks/useTranscriptState";
import { useWorkspaceTopbarState } from "./hooks/useWorkspaceTopbarState";

export const App = () => {
	const sidebarState = useSidebarState();
	const topbarState = useWorkspaceTopbarState();
	const inspectState = useInspectState();
	const transcriptState = useTranscriptState();
	const composerState = useComposerState();
	const modalState = useModalState();

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
			const request = modalState.pendingUiRequest;
			if (request) {
				event.preventDefault();
				void submitModal(resolveModalDismissPayload(request));
				return;
			}
			if (modalState.pendingLocalDialog) {
				event.preventDefault();
				dismissPendingLocalDialog();
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [modalState.pendingLocalDialog, modalState.pendingUiRequest]);

	return (
		<>
			<div
				className={`shell${inspectState.inspectOpen ? " is-inspect-open" : ""}`}
			>
				<AppSidebar
					workspaces={sidebarState.workspaces}
					selectedWorkspacePath={sidebarState.selectedWorkspacePath}
					sessions={sidebarState.sessions}
					selectedSessionId={sidebarState.selectedSessionId}
					onNewChat={() => loadSession(null)}
					onAddWorkspace={openWorkspaceForNewChat}
					onLoadWorkspace={loadWorkspace}
					onLoadSession={loadSession}
					onRenameSession={renameSession}
					onHideSession={requestHideSession}
				/>

				<main className="panel center">
					<WorkspaceTopbar
						workspace={topbarState.workspace}
						runtimeConnected={topbarState.runtimeConnected}
						inspectOpen={inspectState.inspectOpen}
						onToggleInspect={loadInspect}
						onOpenWorkspaceTarget={openWorkspaceTarget}
						onChooseWorkspace={openWorkspaceDialog}
					/>

					<TranscriptPane
						transcript={transcriptState.transcript}
						isStreaming={transcriptState.isStreaming}
						workspace={transcriptState.workspace}
						sessions={transcriptState.sessions}
						runtimeConnected={transcriptState.runtimeConnected}
						runtimeModelLabel={transcriptState.runtimeModelLabel}
						onOpenWorkspace={openWorkspaceDialog}
						onNewChat={() => loadSession(null)}
						onLoadInspect={loadInspect}
						onLoadSession={loadSession}
						onCopySection={(text) => {
							void navigator.clipboard.writeText(text).catch((error) => {
								setErrorMessage(String(error));
							});
						}}
						onOpenLink={openTranscriptLink}
					/>

					<Composer
						workspace={composerState.workspace}
						statusLine={composerState.statusLine}
						errorMessage={composerState.errorMessage}
						composer={composerState.composer}
						selectedWorkspacePath={composerState.selectedWorkspacePath}
						pendingUiRequest={composerState.pendingUiRequest}
						isStreaming={composerState.isStreaming}
						model={composerState.model}
						onComposerChange={setComposer}
						onSend={sendPrompt}
						onCancel={cancelRun}
						onUpdateModel={updateModel}
						onUpdateModelReasoning={updateModelReasoning}
					/>
				</main>

				{inspectState.inspectOpen ? (
					<InspectRail
						inspect={inspectState.inspect}
						onRefresh={refreshInspect}
						onClose={loadInspect}
					/>
				) : null}
			</div>

			<ModalLayer
				request={modalState.pendingUiRequest}
				pendingLocalDialog={modalState.pendingLocalDialog}
				modalText={modalState.modalText}
				modalPickIds={modalState.modalPickIds}
				onChangeModalText={setModalText}
				onToggleModalPick={toggleModalPick}
				onDismissLocalDialog={dismissPendingLocalDialog}
			/>
		</>
	);
};
