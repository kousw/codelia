import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { clampSidebarWidth } from "../shared/layout";
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
	loadNewSessionForWorkspace,
	loadSession,
	loadSkillsForComposer,
	openTranscriptLink,
	openWorkspaceDialog,
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
	switchBranch,
	toggleModalPick,
	updateModel,
	updateModelFast,
	updateModelReasoning,
	updateSidebarWidthPreference,
} from "./controller";
import { useComposerState } from "./hooks/useComposerState";
import { useInspectState } from "./hooks/useInspectState";
import { useModalState } from "./hooks/useModalState";
import { useSidebarState } from "./hooks/useSidebarState";
import { useTranscriptState } from "./hooks/useTranscriptState";
import { useWorkspaceTopbarState } from "./hooks/useWorkspaceTopbarState";
import { PanelLeftOpen, uiIconProps } from "./icons";
import { setSidebarWidth } from "./state/actions";

export const App = () => {
	const sidebarState = useSidebarState();
	const topbarState = useWorkspaceTopbarState();
	const inspectState = useInspectState();
	const transcriptState = useTranscriptState();
	const composerState = useComposerState();
	const modalState = useModalState();
	const [isResizingSidebar, setIsResizingSidebar] = useState(false);
	const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
	const resizeStateRef = useRef<{
		startX: number;
		startWidth: number;
		currentWidth: number;
	} | null>(null);

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

	useEffect(() => {
		if (!isResizingSidebar) {
			return;
		}

		const onPointerMove = (event: PointerEvent) => {
			const resizeState = resizeStateRef.current;
			if (!resizeState) {
				return;
			}
			const nextWidth = clampSidebarWidth(
				resizeState.startWidth + (event.clientX - resizeState.startX),
			);
			resizeState.currentWidth = nextWidth;
			setSidebarWidth(nextWidth);
		};

		const finishResize = () => {
			const resizeState = resizeStateRef.current;
			resizeStateRef.current = null;
			setIsResizingSidebar(false);
			if (resizeState && resizeState.currentWidth !== resizeState.startWidth) {
				void updateSidebarWidthPreference(resizeState.currentWidth);
			}
		};

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", finishResize);
		window.addEventListener("pointercancel", finishResize);
		return () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", finishResize);
			window.removeEventListener("pointercancel", finishResize);
		};
	}, [isResizingSidebar]);

	const startSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
		event.preventDefault();
		resizeStateRef.current = {
			startX: event.clientX,
			startWidth: sidebarState.sidebarWidth,
			currentWidth: sidebarState.sidebarWidth,
		};
		setIsResizingSidebar(true);
	};

	return (
		<>
			<div
				className={`shell${
					inspectState.inspectOpen ? " is-inspect-open" : ""
				}${isResizingSidebar ? " is-resizing-sidebar" : ""}${
					isSidebarCollapsed ? " is-sidebar-collapsed" : ""
				}`}
			>
				<AppSidebar
					workspaces={sidebarState.workspaces}
					selectedWorkspacePath={sidebarState.selectedWorkspacePath}
					sessions={sidebarState.sessions}
					selectedSessionId={sidebarState.selectedSessionId}
					sidebarWidth={sidebarState.sidebarWidth}
					isResizing={isResizingSidebar}
					isCollapsed={isSidebarCollapsed}
					onAddWorkspace={openWorkspaceDialog}
					onNewChatForWorkspace={loadNewSessionForWorkspace}
					onLoadSession={loadSession}
					onRenameSession={renameSession}
					onHideSession={requestHideSession}
					onCollapse={() => setIsSidebarCollapsed(true)}
					onStartResize={startSidebarResize}
				/>

				<main className="panel center">
					{isSidebarCollapsed ? (
						<button
							type="button"
							className="button button-subtle icon-button sidebar-reopen-button electrobun-webkit-app-region-no-drag"
							aria-label="Show sidebar"
							title="Show sidebar"
							onClick={() => setIsSidebarCollapsed(false)}
						>
							<PanelLeftOpen {...uiIconProps} className="button-icon" />
						</button>
					) : null}
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
						statusLine={composerState.statusLine}
						composerNotice={composerState.composerNotice}
						errorMessage={composerState.errorMessage}
						composer={composerState.composer}
						pendingShellResultCount={composerState.pendingShellResultCount}
						selectedWorkspacePath={composerState.selectedWorkspacePath}
						pendingUiRequest={composerState.pendingUiRequest}
						isStreaming={composerState.isStreaming}
						isShellRunning={composerState.isShellRunning}
						contextLeftPercent={composerState.contextLeftPercent}
						model={composerState.model}
						git={composerState.git}
						onComposerChange={setComposer}
						onLoadSkills={loadSkillsForComposer}
						onSend={sendPrompt}
						onCancel={cancelRun}
						onSwitchBranch={switchBranch}
						onUpdateModel={updateModel}
						onUpdateModelReasoning={updateModelReasoning}
						onUpdateModelFast={updateModelFast}
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
